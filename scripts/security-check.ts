// npm run test:security: the security suite (PLAN.md § 3.8, M10), against the running app
// (`make dev`) and local Supabase. Every attempt is one row of the printed pass/fail table.
//   1. Fixtures: glenfold creates a shortlist with a person and a saved brief through our API, with
//      its real seeded login. Two glenfold searches (one done, one pending) are inserted over `pg`,
//      because running a real one would spend glenfold's free search.
//   2. As asterwell (the real seeded token), against glenfold's real ids: every id route of our API; then
//      PostgREST directly with asterwell's token (select, insert with company_id = glenfold, update,
//      delete and upsert on every table; every RPC; the private schema; /graphql/v1; auth admin).
//   3. As anon (publishable key, no token): every table, every RPC, GraphQL, sign-up.
//   4. Quota RPCs that would spend a search run as a throwaway company, never as asterwell.
//   5. Glenfold's rows are compared byte for byte (every column, as Postgres renders the row) and
//      through glenfold's own API responses; candidates, billing events and asterwell are checked too.
//   6. Secret scan: the HTML and RSC payloads of every page in the build output, signed in and
//      out, and every file in .next/static, for secret values (loaded from .env.local, the
//      environment and `supabase status`), secret names, key patterns and non-anon JWTs.
//   7. eval/hostile.json through POST /api/search as a throwaway paid company: no 5xx, never
//      everyone, the expected outcome, no secret or prompt text in the response, no rows changed.
// Cleanup deletes the fixtures and the throwaway companies, then checks asterwell and glenfold are back to
// where they started. Options: --base-url <url> (default http://localhost:3000).
// Never prints a key, a token or a secret: findings name the secret and where it was found, and
// response bodies are reduced to a status, an error code and a row count.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { promptFragmentIn } from '@/lib/server/search/prompt';
import { DEMO_ACCOUNTS } from '@/lib/shared/demo-accounts';
import { Filters } from '@/lib/shared/filters';
import { closeDb, db } from '../tests/integration/helpers/db';
import { signIn, type Session } from '../tests/integration/helpers/supabase';
import { createTenant, setSubscription, type Tenant } from '../tests/integration/helpers/tenant';

const ROOT = path.resolve(import.meta.dirname, '..');
const { values: opts } = parseArgs({ options: { 'base-url': { type: 'string', default: 'http://localhost:3000' } } });
const BASE_URL = (opts['base-url'] ?? '').replace(/\/$/, '');

if (existsSync(path.join(ROOT, '.env.local'))) process.loadEnvFile(path.join(ROOT, '.env.local'));
function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set: run \`make setup\` first. Nothing was run.`);
    process.exit(1);
  }
  return value;
}
const SUPABASE_URL = env('SUPABASE_URL').replace(/\/$/, '');
const PUBLISHABLE_KEY = env('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
env('SUPABASE_SECRET_KEY');
env('DATABASE_URL');
const HAS_MODEL_KEY = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

// ---- the table ----

type Verdict = 'pass' | 'FAIL' | 'skip';
type Row = { area: string; attempt: string; expected: string; got: string; verdict: Verdict };
const rows: Row[] = [];
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

function record(area: string, attempt: string, expected: string, got: string, ok: boolean | 'skip'): void {
  const verdict: Verdict = ok === 'skip' ? 'skip' : ok ? 'pass' : 'FAIL';
  rows.push({ area, attempt, expected, got, verdict });
  console.log(`${pad(verdict, 4)}  ${pad(area, 9)} ${pad(attempt, 70)} ${pad(expected, 26)} ${got}`);
}

function section(title: string): void {
  console.log(`\n## ${title}\n`);
  console.log(`${pad('', 4)}  ${pad('area', 9)} ${pad('attempt', 70)} ${pad('expected', 26)} got`);
}

// ---- HTTP ----

type Http = { status: number; type: string; location: string | null; text: string; json: unknown };

async function http(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Http> {
  const headers = { ...init.headers };
  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await fetch(url, { method: init.method ?? 'GET', headers, body, redirect: 'manual' });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = undefined;
  }
  return { status: res.status, type: res.headers.get('content-type') ?? '', location: res.headers.get('location'), text, json };
}

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;

/** Our API, as one recruiter (or signed out when token is null). */
const api = (token: string | null, method: string, route: string, body?: unknown) =>
  http(`${BASE_URL}${route}`, { method, body, headers: token ? { authorization: `Bearer ${token}` } : {} });

/** Supabase directly (Kong → PostgREST / GoTrue), with the publishable key and maybe a user token. */
function supabase(token: string | null, method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { apikey: PUBLISHABLE_KEY, prefer: 'return=representation', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  return http(`${SUPABASE_URL}${route}`, { method, body, headers: h });
}

/** A response reduced to what is safe to print: status, error code, row count. */
function outcome(r: Http): string {
  if (r.status >= 400) {
    const code = field(r.json, 'error_code') ?? field(r.json, 'code');
    return `${r.status}${typeof code === 'string' || typeof code === 'number' ? ` ${code}` : ''}`;
  }
  if (Array.isArray(r.json)) return `${r.status}, ${r.json.length} row${r.json.length === 1 ? '' : 's'}`;
  return String(r.status);
}

/** Refused outright, or allowed to run but reached no row. */
const refused = (r: Http) => r.status >= 400 || (Array.isArray(r.json) && r.json.length === 0);

/** GraphQL answers 200 with `errors` and no `data` for a bad query, so data is what matters. */
const graphqlRefused = (r: Http) => {
  const data = field(r.json, 'data');
  return r.status >= 400 || data === undefined || data === null || Object.values(data as object).every((v) => v === null);
};

// ---- database snapshots (as postgres, over pg) ----

// Table names come from these constants, never from input.
const COMPANY_TABLES = [
  ['companies', 'id'],
  ['recruiters', 'company_id'],
  ['company_usage', 'company_id'],
  ['subscriptions', 'company_id'],
  ['shortlists', 'company_id'],
  ['shortlist_people', 'company_id'],
  ['saved_briefs', 'company_id'],
  ['searches', 'company_id'],
  ['search_results', 'company_id'],
] as const;

type Snapshot = Map<string, { n: number; text: string }>;

/** Every row a company owns, each rendered by Postgres as text (every column), in a fixed order. */
async function companySnapshot(companyId: string): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  for (const [table, column] of COMPANY_TABLES) {
    const { rows: r } = await db().query<{ n: number; text: string }>(
      `select count(*)::int as n, coalesce(string_agg(t::text, E'\\n' order by t::text collate "C"), '') as text
       from public.${table} t where t.${column} = $1`,
      [companyId],
    );
    snap.set(table, r[0] ?? { n: 0, text: '' });
  }
  return snap;
}

/** Shared data an attack could reach without a company: candidates, billing events, tenants, users. */
async function globalSnapshot(): Promise<Snapshot> {
  const queries: [string, string][] = [
    ['candidates', `select count(*)::int as n, md5(coalesce(string_agg(t::text, E'\\n' order by t.id collate "C"), '')) as text from public.candidates t`],
    ['candidate_experiences', `select count(*)::int as n, md5(coalesce(string_agg(t::text, E'\\n' order by t.candidate_id collate "C", t.position), '')) as text from public.candidate_experiences t`],
    ['candidate_education', `select count(*)::int as n, md5(coalesce(string_agg(t::text, E'\\n' order by t.candidate_id collate "C", t.position), '')) as text from public.candidate_education t`],
    ['processed_stripe_events', `select count(*)::int as n, md5(coalesce(string_agg(t::text, E'\\n' order by t.event_id collate "C"), '')) as text from public.processed_stripe_events t`],
    // Throwaway companies (slug t-…) and their users (@tenant.test) come and go during the run.
    ['companies (not throwaway)', `select count(*)::int as n, md5(coalesce(string_agg(t::text, E'\\n' order by t.id), '')) as text from public.companies t where t.slug not like 't-%'`],
    ['auth users (not throwaway)', `select count(*)::int as n, md5(coalesce(string_agg(u.id::text || u.email, E'\\n' order by u.id), '')) as text from auth.users u where u.email not like '%@tenant.test'`],
  ];
  const snap: Snapshot = new Map();
  for (const [name, sql] of queries) {
    const { rows: r } = await db().query<{ n: number; text: string }>(sql);
    snap.set(name, r[0] ?? { n: 0, text: '' });
  }
  return snap;
}

function compare(area: string, label: string, before: Snapshot, after: Snapshot): boolean {
  let all = true;
  for (const [table, b] of before) {
    const a = after.get(table);
    const same = a !== undefined && a.n === b.n && a.text === b.text;
    all &&= same;
    record(area, `${label}: ${table}`, 'byte-for-byte unchanged', same ? `unchanged (${b.n} rows)` : `CHANGED (${b.n} → ${a?.n ?? '?'} rows)`, same);
  }
  return all;
}

// ---- secrets ----

type Secret = { name: string; value: string };

// The names of our server-only variables; none may reach the browser (CLAUDE.md § Security rules).
const SECRET_NAMES = ['SUPABASE_SECRET_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY', 'DATABASE_URL'];
// supabase-js itself contains the bare literal "sb_secret_" (its key-type check), so a prefix
// counts only when key characters follow it.
const PATTERNS: [string, RegExp][] = [
  ['sb_secret_ followed by key characters', /sb_secret_[A-Za-z0-9_-]{8,}/],
  ['sk-ant- followed by key characters', /sk-ant-[A-Za-z0-9_-]{8,}/],
  ['whsec_ followed by key characters', /whsec_[A-Za-z0-9_+/=-]{8,}/],
  ['a Stripe secret or restricted key', /\b[sr]k_(?:test|live)_[A-Za-z0-9]{8,}/],
];
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]+/g;

let loaded: { secrets: Secret[]; problems: string[] } | undefined;

/** The secret scan and the hostile briefs both need the values; the CLI is asked once. */
const loadSecrets = () => (loaded ??= readSecrets());

/**
 * Every secret value we can know: the server's variables (environment, then .env.local) and the
 * local stack's own secrets from `supabase status -o json`, read from a pipe and kept in memory.
 */
function readSecrets(): { secrets: Secret[]; problems: string[] } {
  const secrets: Secret[] = [];
  const problems: string[] = [];
  const add = (name: string, value: string | undefined) => {
    const v = value?.trim();
    // Short values (a bare local password) would match ordinary text; the longer forms are kept.
    if (v && v.length >= 12 && !secrets.some((s) => s.value === v)) secrets.push({ name, value: v });
  };
  for (const name of SECRET_NAMES) add(name, process.env[name]);
  try {
    const out = execFileSync(path.join(ROOT, 'node_modules/.bin/supabase'), ['status', '-o', 'json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    const status = JSON.parse(out.slice(out.indexOf('{'))) as Record<string, unknown>;
    for (const [key, value] of Object.entries(status)) {
      if (typeof value === 'string' && /SECRET|SERVICE_ROLE|DB_URL|PASSWORD/.test(key)) add(`supabase status ${key}`, value);
    }
    if (!secrets.some((s) => s.name === 'supabase status JWT_SECRET')) problems.push('supabase status listed no JWT_SECRET');
  } catch (err) {
    problems.push(`couldn't read \`supabase status -o json\` (${err instanceof Error ? err.name : 'error'})`);
  }
  return { secrets, problems };
}

function jwtRole(payload: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    const role = field(claims, 'role');
    return typeof role === 'string' ? role : 'unknown';
  } catch {
    return undefined;
  }
}

/** What in `text` is secret, by label only; the matched text itself is never returned. */
function findSecrets(text: string, secrets: Secret[]): string[] {
  const found: string[] = [];
  for (const s of secrets) if (text.includes(s.value)) found.push(`the value of ${s.name}`);
  for (const name of SECRET_NAMES) if (text.includes(name)) found.push(`the name ${name}`);
  for (const [label, re] of PATTERNS) if (re.test(text)) found.push(label);
  for (const m of text.matchAll(JWT)) {
    const role = m[1] ? jwtRole(m[1]) : undefined;
    // The anon key is public by design; any other JWT (service_role, a user's token) is not.
    if (role !== undefined && role !== 'anon') found.push(`a JWT with role ${role}`);
  }
  return [...new Set(found)];
}

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (entry.isFile()) yield full;
  }
}

function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) yield* strings(v);
}

// ---- fixtures ----

type Ctx = {
  asterwell: Session;
  glenfold: Session;
  A: string;
  G: string;
  candidates: [string, string, string];
  gList: string;
  gPerson: string;
  gSaved: string;
  gDone: string;
  gPending: string;
  aList?: string;
  aSaved?: string;
};

async function companyId(slug: string): Promise<string> {
  const { rows: r } = await db().query<{ id: string }>('select id from public.companies where slug = $1', [slug]);
  const id = r[0]?.id;
  if (!id) throw new Error(`company ${slug} is missing: run \`make setup\``);
  return id;
}

async function createId(res: Http, what: string): Promise<string> {
  const id = field(res.json, 'id');
  if (res.status !== 200 || typeof id !== 'string') throw new Error(`creating ${what} failed: ${outcome(res)}`);
  return id;
}

// ---- 2. our API as asterwell ----

async function apiAttacks(c: Ctx): Promise<void> {
  section('our API, signed in as asterwell, against glenfold’s real ids');
  const A = c.asterwell.accessToken;
  const area = 'api';
  const is404 = (r: Http) => r.status === 404;

  const lists = await api(A, 'GET', '/api/shortlists');
  const listIds = Array.isArray(lists.json) ? lists.json.map((l) => field(l, 'id')) : null;
  record(area, 'GET /api/shortlists lists no glenfold list', 'glenfold id absent', `${lists.status}, ${listIds?.length ?? '?'} lists`, lists.status === 200 && !!listIds && !listIds.includes(c.gList));
  const saved = await api(A, 'GET', '/api/saved-briefs');
  const savedIds = Array.isArray(saved.json) ? saved.json.map((s) => field(s, 'id')) : null;
  record(area, 'GET /api/saved-briefs lists no glenfold saved search', 'glenfold id absent', `${saved.status}, ${savedIds?.length ?? '?'} saved`, saved.status === 200 && !!savedIds && !savedIds.includes(c.gSaved));

  const attempts: [string, () => Promise<Http>][] = [
    ['GET /api/shortlists/{glenfold list}', () => api(A, 'GET', `/api/shortlists/${c.gList}`)],
    ['PATCH /api/shortlists/{glenfold list} (rename)', () => api(A, 'PATCH', `/api/shortlists/${c.gList}`, { name: 'renamed by asterwell' })],
    ['DELETE /api/shortlists/{glenfold list}', () => api(A, 'DELETE', `/api/shortlists/${c.gList}`)],
    ['POST /api/shortlists/{glenfold list}/people/{person} (add)', () => api(A, 'POST', `/api/shortlists/${c.gList}/people/${c.candidates[1]}`)],
    ['DELETE /api/shortlists/{glenfold list}/people/{their person} (remove)', () => api(A, 'DELETE', `/api/shortlists/${c.gList}/people/${c.gPerson}`)],
    ['DELETE /api/saved-briefs/{glenfold saved search}', () => api(A, 'DELETE', `/api/saved-briefs/${c.gSaved}`)],
    ['GET /api/search/{glenfold done search}?page=1', () => api(A, 'GET', `/api/search/${c.gDone}?page=1`)],
    ['GET /api/search/{glenfold done search}?page=2', () => api(A, 'GET', `/api/search/${c.gDone}?page=2`)],
    ['GET /api/search/{glenfold pending search}', () => api(A, 'GET', `/api/search/${c.gPending}`)],
    ['GET /api/search/{glenfold done search}/broader', () => api(A, 'GET', `/api/search/${c.gDone}/broader`)],
  ];
  for (const [attempt, run] of attempts) {
    const r = await run();
    record(area, attempt, '404', outcome(r), is404(r));
  }

  // No existence oracle: another company's id and an id that doesn't exist look the same.
  const theirs = await api(A, 'GET', `/api/shortlists/${c.gList}`);
  const unknown = await api(A, 'GET', `/api/shortlists/${randomUUID()}`);
  record(area, '404 for glenfold’s list is byte-identical to an unknown id’s', 'identical bodies', theirs.text === unknown.text ? 'identical' : 'different', theirs.status === 404 && theirs.text === unknown.text);

  // A company id smuggled into a create body is ignored: the row lands in asterwell. These two rows
  // are asterwell's own probes for the PostgREST "move my row into glenfold" attempts, deleted at the end.
  const list = await api(A, 'POST', '/api/shortlists', { name: 'M10 security probe', company_id: c.G });
  c.aList = await createId(list, "asterwell's probe list");
  const brief = await api(A, 'POST', '/api/saved-briefs', { brief: 'M10 security probe', filters: { roles: ['Recruiter'] }, company_id: c.G });
  c.aSaved = await createId(brief, "asterwell's probe saved search");
  const added = await api(A, 'POST', `/api/shortlists/${c.aList}/people/${c.candidates[2]}`);
  if (added.status !== 200) throw new Error(`adding to asterwell's probe list failed: ${outcome(added)}`);
  const { rows: owners } = await db().query<{ company_id: string }>(
    'select company_id from public.shortlists where id = $1 union all select company_id from public.saved_briefs where id = $2',
    [c.aList, c.aSaved],
  );
  const inAsterwell = owners.length === 2 && owners.every((o) => o.company_id === c.A);
  record(area, 'POST list / saved search with "company_id": glenfold in the body', 'row is created in asterwell', inAsterwell ? 'created in asterwell' : 'NOT in asterwell', inAsterwell);
}

// ---- 3. PostgREST directly with asterwell's token ----

type TableAttack = {
  table: string;
  select?: string;
  insert: Record<string, unknown>;
  update: [query: string, patch: Record<string, unknown>];
  del: string;
  upsert: [row: Record<string, unknown>, onConflict: string];
  shared?: boolean;
};

function tableAttacks(c: Ctx): TableAttack[] {
  const { A, G } = c;
  const [cand, other] = c.candidates;
  const byG = `company_id=eq.${G}`;
  const person = {
    id: 'm10_attack', full_name: 'Attack', avatar_url: 'https://example.test/a.svg', headline: 'x', current_title: 'x',
    current_company: 'x', current_company_logo_url: 'https://example.test/l.svg', role: 'Recruiter', seniority: 'mid',
    years_experience: 3, city: 'Denver', state: 'CO', country: 'US', open_to_work: true, skills: ['Go'],
  };
  const job = { candidate_id: cand, position: 9, title: 'x', company: 'x', company_type: 'startup', company_logo_url: 'https://example.test/l.svg', start_year: 2020, end_year: 2021, description: 'x' };
  const school = { candidate_id: cand, position: 9, school: 'x', degree: 'BS', field: 'x', graduation_year: 2020 };
  const sub = { stripe_subscription_id: 'sub_m10_attack', company_id: G, status: 'canceled', last_event_id: 'evt_m10_attack', last_event_created: 9_999_999_999, last_event_type: 'customer.subscription.deleted' };
  return [
    { table: 'companies', select: `id=eq.${G}`, insert: { slug: 'm10-attack', name: 'attack' }, update: [`id=eq.${G}`, { name: 'renamed by asterwell' }], del: `id=eq.${G}`, upsert: [{ id: G, slug: 'glenfold', name: 'renamed by asterwell' }, 'id'] },
    { table: 'recruiters', select: byG, insert: { user_id: c.asterwell.userId, company_id: G }, update: [`user_id=eq.${c.glenfold.userId}`, { company_id: A }], del: byG, upsert: [{ user_id: c.asterwell.userId, company_id: G }, 'user_id'] },
    { table: 'candidates', shared: true, insert: person, update: [`id=eq.${cand}`, { full_name: 'renamed by asterwell' }], del: `id=eq.${cand}`, upsert: [{ ...person, id: cand }, 'id'] },
    { table: 'candidate_experiences', shared: true, insert: job, update: [`candidate_id=eq.${cand}`, { title: 'renamed by asterwell' }], del: `candidate_id=eq.${cand}`, upsert: [{ ...job, position: 0 }, 'candidate_id,position'] },
    { table: 'candidate_education', shared: true, insert: school, update: [`candidate_id=eq.${cand}`, { school: 'renamed by asterwell' }], del: `candidate_id=eq.${cand}`, upsert: [{ ...school, position: 0 }, 'candidate_id,position'] },
    { table: 'shortlists', select: byG, insert: { name: 'planted by asterwell', company_id: G }, update: [byG, { name: 'renamed by asterwell' }], del: byG, upsert: [{ id: c.gList, name: 'renamed by asterwell' }, 'id'] },
    { table: 'shortlist_people', select: byG, insert: { shortlist_id: c.gList, candidate_id: other, company_id: G }, update: [byG, { candidate_id: other }], del: byG, upsert: [{ shortlist_id: c.gList, candidate_id: c.gPerson }, 'shortlist_id,candidate_id'] },
    { table: 'saved_briefs', select: byG, insert: { brief: 'planted by asterwell', filters: {}, company_id: G }, update: [byG, { brief: 'renamed by asterwell' }], del: byG, upsert: [{ id: c.gSaved, brief: 'renamed by asterwell', filters: {} }, 'id'] },
    { table: 'searches', select: byG, insert: { company_id: G, recruiter_id: c.asterwell.userId, brief: 'planted by asterwell', source: 'brief' }, update: [byG, { brief: 'renamed by asterwell' }], del: byG, upsert: [{ id: c.gPending, company_id: G, recruiter_id: c.glenfold.userId, brief: 'renamed by asterwell', source: 'brief' }, 'id'] },
    { table: 'search_results', select: byG, insert: { search_id: c.gDone, rank: 99, company_id: G, candidate_id: other }, update: [byG, { candidate_id: other }], del: byG, upsert: [{ search_id: c.gDone, rank: 1, company_id: G, candidate_id: other }, 'search_id,rank'] },
    // Burning a rival's free search, or giving it back.
    { table: 'company_usage', select: byG, insert: { company_id: G, searches_used: 1 }, update: [byG, { searches_used: 1 }], del: byG, upsert: [{ company_id: G, searches_used: 1 }, 'company_id'] },
    { table: 'subscriptions', select: byG, insert: sub, update: [byG, { status: 'canceled' }], del: byG, upsert: [{ ...sub, status: 'past_due' }, 'stripe_subscription_id'] },
    { table: 'processed_stripe_events', select: 'limit=5', insert: { event_id: 'evt_m10_attack', type: 'x', created: 0, outcome: 'applied' }, update: ['event_id=not.is.null', { outcome: 'changed by asterwell' }], del: 'event_id=not.is.null', upsert: [{ event_id: 'evt_m10_attack', type: 'x', created: 0, outcome: 'applied' }, 'event_id'] },
  ];
}

async function postgrestAttacks(c: Ctx): Promise<void> {
  section('Supabase directly with asterwell’s token (PostgREST, RPC, GraphQL, auth admin)');
  const T = c.asterwell.accessToken;
  const area = 'rest';
  for (const t of tableAttacks(c)) {
    const base = `/rest/v1/${t.table}`;
    if (t.shared) {
      const r = await supabase(T, 'GET', `${base}?select=*&limit=1`);
      record(area, `select ${t.table} (shared catalogue, read-only)`, 'readable by design', outcome(r), r.status === 200);
    } else {
      const r = await supabase(T, 'GET', `${base}?select=*&${t.select ?? ''}`);
      record(area, `select ${t.table} where it is glenfold’s`, 'refused or 0 rows', outcome(r), refused(r));
    }
    const ins = await supabase(T, 'POST', base, t.insert);
    record(area, `insert into ${t.table}${'company_id' in t.insert && t.insert.company_id === c.G ? ' with company_id = glenfold' : ''}`, 'refused', outcome(ins), ins.status >= 400);
    const upd = await supabase(T, 'PATCH', `${base}?${t.update[0]}`, t.update[1]);
    record(area, `update ${t.table} (${Object.keys(t.update[1]).join(', ')}) on ${t.shared ? 'a candidate' : 'glenfold’s rows'}`, 'refused or 0 rows', outcome(upd), refused(upd));
    const del = await supabase(T, 'DELETE', `${base}?${t.del}`);
    record(area, `delete from ${t.table} where ${t.shared ? 'a candidate' : 'glenfold’s rows'}`, 'refused or 0 rows', outcome(del), refused(del));
    const ups = await supabase(T, 'POST', `${base}?on_conflict=${t.upsert[1]}`, t.upsert[0], { prefer: 'return=representation,resolution=merge-duplicates' });
    record(area, `upsert into ${t.table} on ${t.shared ? 'a real candidate key' : 'glenfold’s real key'}`, 'refused', outcome(ups), ups.status >= 400);
  }

  // Asterwell's own rows: moving them into glenfold, or changing what only the server may change.
  const own: [string, () => Promise<Http>][] = [
    ['update own recruiter row: company_id = glenfold', () => supabase(T, 'PATCH', `/rest/v1/recruiters?user_id=eq.${c.asterwell.userId}`, { company_id: c.G })],
    ['update own usage: searches_used = 0', () => supabase(T, 'PATCH', `/rest/v1/company_usage?company_id=eq.${c.A}`, { searches_used: 0 })],
    ['insert an active subscription for asterwell (self-upgrade)', () => supabase(T, 'POST', '/rest/v1/subscriptions', { stripe_subscription_id: 'sub_m10_self', company_id: c.A, status: 'active', last_event_id: 'evt_m10_self', last_event_created: 9_999_999_999, last_event_type: 'customer.subscription.created' })],
    ['update own list: company_id = glenfold', () => supabase(T, 'PATCH', `/rest/v1/shortlists?id=eq.${c.aList}`, { company_id: c.G })],
    ['update own saved search: company_id = glenfold', () => supabase(T, 'PATCH', `/rest/v1/saved_briefs?id=eq.${c.aSaved}`, { company_id: c.G })],
    ['update own list member: shortlist_id = glenfold’s list', () => supabase(T, 'PATCH', `/rest/v1/shortlist_people?shortlist_id=eq.${c.aList}`, { shortlist_id: c.gList })],
    ['insert a person into glenfold’s list without a company_id', () => supabase(T, 'POST', '/rest/v1/shortlist_people', { shortlist_id: c.gList, candidate_id: c.candidates[1] })],
    ['insert a list with created_by = glenfold’s recruiter', () => supabase(T, 'POST', '/rest/v1/shortlists', { name: 'spoofed', created_by: c.glenfold.userId })],
  ];
  for (const [attempt, run] of own) {
    const r = await run();
    record(area, attempt, 'refused', outcome(r), r.status >= 400);
  }
  const wide: [string, () => Promise<Http>][] = [
    ['select every list not asterwell’s (company_id=neq.asterwell)', () => supabase(T, 'GET', `/rest/v1/shortlists?select=*&company_id=neq.${c.A}`)],
    ['update every saved search not asterwell’s (company_id=neq.asterwell)', () => supabase(T, 'PATCH', `/rest/v1/saved_briefs?company_id=neq.${c.A}`, { brief: 'renamed by asterwell' })],
    ['delete every list not asterwell’s (company_id=neq.asterwell)', () => supabase(T, 'DELETE', `/rest/v1/shortlists?company_id=neq.${c.A}`)],
  ];
  for (const [attempt, run] of wide) {
    const r = await run();
    record(area, attempt, 'refused or 0 rows', outcome(r), refused(r));
  }

  section('RPC and other endpoints with asterwell’s token');
  const rpc = (fn: string, args: Record<string, unknown>, headers: Record<string, string> = {}) => supabase(T, 'POST', `/rest/v1/rpc/${fn}`, args, headers);
  const filters = { roles: ['Recruiter'] };
  const rpcs: [string, () => Promise<Http>][] = [
    ['complete_search on glenfold’s pending search', () => rpc('complete_search', { p_search_id: c.gPending, p_filters: filters })],
    ['complete_search on glenfold’s done search', () => rpc('complete_search', { p_search_id: c.gDone, p_filters: filters })],
    ['release_search on glenfold’s pending search', () => rpc('release_search', { p_search_id: c.gPending })],
    ['get_search_page on glenfold’s done search', () => rpc('get_search_page', { p_search_id: c.gDone, p_page: 1 })],
    ['count_relaxations on glenfold’s done search', () => rpc('count_relaxations', { p_search_id: c.gDone, p_variants: [filters] })],
    ['get_plan with glenfold’s company id as a parameter', () => rpc('get_plan', { p_company_id: c.G })],
    ['apply_stripe_event: cancel glenfold', () => rpc('apply_stripe_event', { p_event_id: 'evt_m10_attack', p_type: 'customer.subscription.deleted', p_created: 9_999_999_999, p_subscription_id: 'sub_m10_attack', p_status: 'canceled', p_company: 'glenfold', p_customer: null, p_current_period_end: null })],
    ['apply_stripe_event: upgrade asterwell', () => rpc('apply_stripe_event', { p_event_id: 'evt_m10_self', p_type: 'customer.subscription.created', p_created: 9_999_999_999, p_subscription_id: 'sub_m10_self', p_status: 'active', p_company: 'asterwell', p_customer: null, p_current_period_end: null })],
    ['private.current_company_id via Content-Profile: private', () => rpc('current_company_id', {}, { 'content-profile': 'private' })],
    ['private.require_company via Content-Profile: private', () => rpc('require_company', {}, { 'content-profile': 'private' })],
    ['private.match_candidates via Content-Profile: private', () => rpc('match_candidates', { p_filters: filters }, { 'content-profile': 'private' })],
    ['match_candidates as a public RPC', () => rpc('match_candidates', { p_filters: filters })],
    ['select private.recruiters via Accept-Profile: private', () => supabase(T, 'GET', '/rest/v1/recruiters?select=*', undefined, { 'accept-profile': 'private' })],
  ];
  for (const [attempt, run] of rpcs) {
    const r = await run();
    record(area, attempt, 'refused', outcome(r), r.status >= 400);
  }
  const plan = await rpc('get_plan', {});
  const viaApi = await api(T, 'GET', '/api/plan');
  const samePlan = JSON.stringify(plan.json) === JSON.stringify(viaApi.json);
  record(area, 'get_plan() returns asterwell’s own plan only', 'asterwell’s plan (= /api/plan)', `${plan.status}, ${samePlan ? 'same as asterwell’s /api/plan' : 'different'}`, plan.status === 200 && samePlan);

  const gql = (query: string) => supabase(T, 'POST', '/graphql/v1', { query });
  const q = await gql('{ shortlistsCollection { edges { node { id company_id name } } } }');
  record(area, '/graphql/v1 query shortlistsCollection', 'refused, no data', outcome(q), graphqlRefused(q));
  const m = await gql(`mutation { deleteFromshortlistsCollection(filter: { company_id: { eq: "${c.G}" } }, atMost: 100) { affectedCount } }`);
  record(area, '/graphql/v1 mutation deleteFromshortlistsCollection (glenfold)', 'refused, no data', outcome(m), graphqlRefused(m));
  const admin = await supabase(T, 'GET', '/auth/v1/admin/users');
  record(area, 'GET /auth/v1/admin/users (list every user)', 'refused', outcome(admin), admin.status >= 400);
  const adminDel = await supabase(T, 'DELETE', `/auth/v1/admin/users/${c.glenfold.userId}`);
  record(area, 'DELETE /auth/v1/admin/users/{glenfold recruiter}', 'refused', outcome(adminDel), adminDel.status >= 400);
}

// ---- 3b. anon ----

async function anonAttacks(c: Ctx): Promise<void> {
  section('anon: the publishable key with no token');
  const area = 'anon';
  for (const t of tableAttacks(c)) {
    const r = await supabase(null, 'GET', `/rest/v1/${t.table}?select=*&limit=5`);
    record(area, `select ${t.table}`, 'refused or 0 rows', outcome(r), refused(r));
  }
  const writes: [string, () => Promise<Http>][] = [
    ['insert a list into glenfold', () => supabase(null, 'POST', '/rest/v1/shortlists', { name: 'planted by anon', company_id: c.G })],
    ['delete glenfold’s lists', () => supabase(null, 'DELETE', `/rest/v1/shortlists?company_id=eq.${c.G}`)],
    ['update glenfold’s usage', () => supabase(null, 'PATCH', `/rest/v1/company_usage?company_id=eq.${c.G}`, { searches_used: 1 })],
  ];
  for (const [attempt, run] of writes) {
    const r = await run();
    record(area, attempt, 'refused or 0 rows', outcome(r), refused(r));
  }
  const rpcs: [string, Record<string, unknown>][] = [
    ['reserve_search', { p_brief: 'anon', p_source: 'brief' }],
    ['complete_search', { p_search_id: c.gPending, p_filters: { roles: ['Recruiter'] } }],
    ['release_search', { p_search_id: c.gPending }],
    ['get_search_page', { p_search_id: c.gDone, p_page: 1 }],
    ['count_relaxations', { p_search_id: c.gDone, p_variants: [] }],
    ['get_plan', {}],
    ['apply_stripe_event', { p_event_id: 'evt_m10_anon', p_type: 'customer.subscription.created', p_created: 9_999_999_999, p_subscription_id: 'sub_m10_anon', p_status: 'active', p_company: 'glenfold', p_customer: null, p_current_period_end: null }],
  ];
  for (const [fn, args] of rpcs) {
    const r = await supabase(null, 'POST', `/rest/v1/rpc/${fn}`, args);
    record(area, `rpc ${fn}`, 'refused', outcome(r), r.status >= 400);
  }
  const g = await supabase(null, 'POST', '/graphql/v1', { query: '{ candidatesCollection { edges { node { id } } } }' });
  record(area, '/graphql/v1 query candidatesCollection', 'refused, no data', outcome(g), graphqlRefused(g));
  const signup = await supabase(null, 'POST', '/auth/v1/signup', { email: `m10-${randomUUID().slice(0, 8)}@attack.test`, password: 'attack-password-123' });
  record(area, 'sign up with email and password', 'refused', outcome(signup), signup.status >= 400);
  const anonymous = await supabase(null, 'POST', '/auth/v1/signup', { data: {} });
  record(area, 'anonymous sign-in', 'refused', outcome(anonymous), anonymous.status >= 400);
  const admin = await supabase(null, 'GET', '/auth/v1/admin/users');
  record(area, 'GET /auth/v1/admin/users', 'refused', outcome(admin), admin.status >= 400);
  const noKey = await http(`${SUPABASE_URL}/rest/v1/candidates?select=id&limit=1`);
  record(area, 'select candidates with no apikey at all', 'refused', outcome(noKey), noKey.status >= 400);
  const ours = await api(null, 'GET', '/api/shortlists');
  record(area, 'GET /api/shortlists with no token', '401', outcome(ours), ours.status === 401);
}

// ---- 4. quota RPCs, as a throwaway company ----

async function quotaAttacks(c: Ctx, tenant: Tenant): Promise<void> {
  section('quota RPCs that spend a search, as a throwaway company (asterwell’s free search is never used)');
  const area = 'quota';
  const T = tenant.accessToken;
  const used = async () => (await db().query<{ n: number }>('select searches_used as n from public.company_usage where company_id = $1', [tenant.companyId])).rows[0]?.n;
  const extra = await supabase(T, 'POST', '/rest/v1/rpc/reserve_search', { p_brief: 'M10 probe', p_source: 'brief', p_company_id: c.G });
  record(area, 'reserve_search with glenfold’s company id as a parameter', 'refused', outcome(extra), extra.status >= 400);
  const reserved = await supabase(T, 'POST', '/rest/v1/rpc/reserve_search', { p_brief: 'M10 probe', p_source: 'brief' });
  const after = await used();
  const searchId = typeof reserved.json === 'string' ? reserved.json : undefined;
  record(area, 'reserve_search: charged to the caller’s own company only', 'throwaway 0 → 1', `${outcome(reserved)}, throwaway used ${after}`, reserved.status === 200 && !!searchId && after === 1);
  const steal = await supabase(c.asterwell.accessToken, 'POST', '/rest/v1/rpc/complete_search', { p_search_id: searchId, p_filters: { roles: ['Recruiter'] } });
  record(area, 'asterwell: complete_search on another company’s pending reservation', 'refused', outcome(steal), steal.status >= 400);
  const released = await supabase(T, 'POST', '/rest/v1/rpc/release_search', { p_search_id: searchId });
  const back = await used();
  record(area, 'release_search gives the throwaway’s search back', 'throwaway 1 → 0', `${outcome(released)}, throwaway used ${back}`, released.status < 300 && back === 0);
}

// ---- 6. secret scan ----

async function secretScan(c: Ctx): Promise<void> {
  section('secret scan: every page’s HTML and RSC payload (signed in and out), every file in .next/static');
  const area = 'secrets';
  const { secrets, problems } = loadSecrets();
  console.log(`   checking ${secrets.length} secret values by name only: ${secrets.map((s) => s.name).join(', ')}`);
  console.log(`   plus the names ${SECRET_NAMES.join(', ')}, ${PATTERNS.length} key patterns, and any JWT whose role isn’t anon\n`);
  record(area, 'secret values loaded for the scan', 'all sources readable', problems.length ? problems.join('; ') : `${secrets.length} values`, problems.length === 0 && secrets.length > 0);
  for (const name of ['SUPABASE_SECRET_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_WEBHOOK_SECRET']) {
    const have = secrets.some((s) => s.name === name);
    record(area, `${name} value is part of the scan`, 'loaded', have ? 'loaded' : 'not set here', have ? true : 'skip');
  }

  const manifestPath = path.join(ROOT, '.next/app-path-routes-manifest.json');
  if (!existsSync(manifestPath)) {
    record(area, 'build output present (.next/app-path-routes-manifest.json)', 'present', 'missing: run `make setup`', false);
    return;
  }
  const routes = [...new Set(Object.values(JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>))]
    .filter((r) => !r.startsWith('/api/'))
    .sort();
  // Dynamic segments get real ids: a candidate for /people/[id], a list id for the rest.
  const pages = [...routes.map((r) => r.replace(/\[[^\]]+\]/g, () => (r.startsWith('/people/') ? c.candidates[0] : c.gList))), `/m10-no-such-page-${randomUUID().slice(0, 8)}`];
  console.log(`   ${pages.length} pages from the build output (+1 unknown path): ${pages.join(' ')}\n`);

  const staticRoot = path.join(ROOT, '.next/static');
  // [label in findings, tag in the got column, request headers, query]
  const variants: [string, string, Record<string, string>, string][] = [
    ['HTML', 'html', { accept: 'text/html' }, ''],
    ['RSC', 'rsc', { rsc: '1' }, '?_rsc=m10a'],
    ['RSC prefetch', 'pre', { rsc: '1', 'next-router-prefetch': '1' }, '?_rsc=m10b'],
    ['RSC segment prefetch', 'seg', { rsc: '1', 'next-router-prefetch': '1', 'next-router-segment-prefetch': '/_tree' }, '?_rsc=m10c'],
  ];
  const signedIn = { authorization: `Bearer ${c.asterwell.accessToken}`, cookie: `sb-access-token=${c.asterwell.accessToken}` };
  const missingAssets = new Set<string>();
  for (const [state, auth] of [['signed out', {}], ['signed in', signedIn]] as const) {
    for (const page of pages) {
      const found: string[] = [];
      const got: string[] = [];
      let htmlOk = false;
      let rscOk = false;
      // Next's built-in global error page renders with status 500 by design; any other 5xx means
      // the page failed, and its error page would be scanned instead of the page.
      const rendered = (r: Http) => r.status < 500 || (page === '/_global-error' && r.status === 500);
      for (const [label, tag, headers, query] of variants) {
        const init = { headers: { ...headers, ...auth } };
        let r = await http(`${BASE_URL}${page}${query}`, init);
        // Next 16 checks the _rsc cache-busting value against the router headers and answers any
        // other value with a 307 to the right one. Followed once, with the same headers.
        const next = r.status === 307 && r.location ? new URL(r.location, BASE_URL) : undefined;
        if (label !== 'HTML' && next && next.origin === new URL(BASE_URL).origin && next.pathname === page && next.searchParams.has('_rsc')) {
          r = await http(next.href, init);
        }
        const isRsc = r.type.includes('text/x-component');
        if (label === 'HTML') htmlOk = rendered(r) && r.type.includes('text/html');
        if (label === 'RSC') rscOk = rendered(r) && isRsc;
        // * marks an RSC request that didn't get an RSC payload back.
        got.push(`${tag} ${r.status}${label !== 'HTML' && !isRsc ? '*' : ''}`);
        found.push(...findSecrets(r.text, secrets).map((f) => `${f} (${label})`));
        if (label === 'HTML') {
          for (const m of r.text.matchAll(/\/_next\/static\/([^"'\s\\)?#]+)/g)) {
            const rel = decodeURIComponent(m[1] ?? '');
            if (!existsSync(path.join(staticRoot, rel))) missingAssets.add(rel);
          }
        }
      }
      const ok = found.length === 0 && htmlOk && rscOk;
      record(area, `${page} (${state})`, 'no secret; html + rsc', found.length ? `FOUND ${found.join('; ')}` : got.join(', '), ok);
    }
  }
  record(area, 'every /_next/static file the pages load is in the scanned build', 'all present', missingAssets.size ? `${missingAssets.size} missing (server runs another build?)` : 'all present', missingAssets.size === 0);

  let count = 0;
  let bytes = 0;
  let barePrefix = 0;
  const staticFindings: string[] = [];
  for (const file of files(staticRoot)) {
    const buf = readFileSync(file);
    count += 1;
    bytes += buf.length;
    // latin1 keeps every byte, so ASCII keys are found in binary files too.
    const text = buf.toString('latin1');
    if (text.includes('sb_secret_')) barePrefix += 1;
    for (const f of findSecrets(text, secrets)) staticFindings.push(`${f} in ${path.relative(ROOT, file)}`);
  }
  record(area, `.next/static: ${count} files, ${(bytes / 1024).toFixed(0)} KB`, 'no secret value or name', staticFindings.length ? `FOUND ${staticFindings.join('; ')}` : 'none found', count > 0 && staticFindings.length === 0);
  if (barePrefix) console.log(`   note: ${barePrefix} file(s) contain the bare literal sb_secret_ with no key characters after it (supabase-js's key-type check)`);
}

// ---- 7. hostile briefs ----

type Hostile = { name: string; brief: string; repeat?: number; expect: 'empty' | 'subset' | 'rejected'; filters?: unknown };

async function hostileBriefs(tenant: Tenant): Promise<void> {
  section(`eval/hostile.json through POST /api/search, as a throwaway paid company${HAS_MODEL_KEY ? '' : ' (ANTHROPIC_API_KEY unset: model briefs skipped)'}`);
  const area = 'hostile';
  const items = JSON.parse(readFileSync(path.join(ROOT, 'eval/hostile.json'), 'utf8')) as Hostile[];
  const { secrets } = loadSecrets();
  const everyone = Number((await db().query<{ n: string }>('select count(*) as n from public.candidates')).rows[0]?.n ?? NaN);
  const counts = async () => {
    const { rows: r } = await db().query<{ t: string; n: string }>(
      `select 'shortlists' t, count(*) n from public.shortlists union all
       select 'shortlist_people', count(*) from public.shortlist_people union all
       select 'saved_briefs', count(*) from public.saved_briefs union all
       select 'searches (other companies)', count(*) from public.searches where company_id <> $1 union all
       select 'search_results (other companies)', count(*) from public.search_results where company_id <> $1 union all
       select 'company_usage', count(*) from public.company_usage union all
       select 'subscriptions', count(*) from public.subscriptions`,
      [tenant.companyId],
    );
    return new Map(r.map((x) => [x.t, Number(x.n)]));
  };
  const beforeCounts = await counts();
  const beforeGlobal = await globalSnapshot();
  for (const h of items) {
    const brief = h.brief.repeat(h.repeat ?? 1);
    if (h.expect !== 'rejected' && !HAS_MODEL_KEY) {
      record(area, h.name, h.expect, 'skipped: ANTHROPIC_API_KEY unset', 'skip');
      continue;
    }
    const r = await api(tenant.accessToken, 'POST', '/api/search', { brief });
    const total = field(r.json, 'total');
    const results = field(r.json, 'results');
    const ids = Array.isArray(results) ? results.map((x) => field(x, 'id')) : [];
    const leaks = [...findSecrets(r.text, secrets)];
    const fragment = promptFragmentIn([...strings(field(r.json, 'filters'))].join('\n'), brief);
    if (fragment) leaks.push('system-prompt text');
    let ok = r.status < 500 && leaks.length === 0;
    let expected = 'no 5xx, never everyone';
    if (h.expect === 'rejected') {
      expected = '400';
      ok &&= r.status === 400;
    } else {
      ok &&= r.status === 200 && typeof total === 'number' && total < everyone;
      if (h.expect === 'empty') {
        expected = '200, 0 results';
        ok &&= total === 0;
      } else {
        const { rows: allowed } = await db().query<{ candidate_id: string }>('select candidate_id from private.match_candidates($1::jsonb)', [JSON.stringify(Filters.parse(h.filters))]);
        const set = new Set(allowed.map((a) => a.candidate_id));
        expected = `200, ⊆ ${set.size} right people`;
        ok &&= typeof total === 'number' && total <= set.size && ids.every((id) => typeof id === 'string' && set.has(id));
      }
    }
    const got = `${outcome(r)}${typeof total === 'number' ? `, total ${total}` : ''}${leaks.length ? `, FOUND ${leaks.join('; ')}` : ''}`;
    record(area, `${h.name}: ${JSON.stringify(h.brief).slice(1, 40)}${h.repeat ? ` ×${h.repeat}` : ''}`, expected, got, ok);
  }
  const afterCounts = await counts();
  for (const [t, n] of beforeCounts) {
    const m = afterCounts.get(t);
    record(area, `rows in ${t} after the hostile briefs`, 'unchanged', m === n ? `unchanged (${n})` : `CHANGED ${n} → ${m}`, m === n);
  }
  compare(area, 'shared data after the hostile briefs', beforeGlobal, await globalSnapshot());
}

// ---- main ----

async function main(): Promise<void> {
  console.log(`# security check against ${BASE_URL} and ${SUPABASE_URL}, ${new Date().toISOString()}`);
  try {
    await fetch(`${BASE_URL}/api/plan`);
  } catch {
    console.error(`The app isn't running at ${BASE_URL}. Start it with \`make dev\`, then rerun.`);
    process.exitCode = 1;
    return;
  }
  const [asterwellAccount, glenfoldAccount] = DEMO_ACCOUNTS;
  const asterwell = await signIn(asterwellAccount.email);
  const glenfold = await signIn(glenfoldAccount.email);
  const A = await companyId(asterwellAccount.slug);
  const G = await companyId(glenfoldAccount.slug);
  const { rows: cands } = await db().query<{ id: string }>('select id from public.candidates order by id collate "C" limit 3');
  const [c0, c1, c2] = cands.map((r) => r.id);
  if (!c0 || !c1 || !c2) throw new Error('candidates are missing: run `make setup`');

  const asterwellStart = await companySnapshot(A);
  const glenfoldStart = await companySnapshot(G);
  const tenants: Tenant[] = [];
  const created: { gList?: string; gSaved?: string; searches: string[] } = { searches: [] };
  let c: Ctx | undefined;
  try {
    // 1. glenfold's fixtures: real rows with real ids, made with its own login.
    const gList = await createId(await api(glenfold.accessToken, 'POST', '/api/shortlists', { name: 'M10 security fixture' }), "glenfold's list");
    created.gList = gList;
    const added = await api(glenfold.accessToken, 'POST', `/api/shortlists/${gList}/people/${c0}`);
    if (added.status !== 200) throw new Error(`adding to glenfold's list failed: ${outcome(added)}`);
    const gSaved = await createId(await api(glenfold.accessToken, 'POST', '/api/saved-briefs', { brief: 'M10 security fixture', filters: { roles: ['Recruiter'] } }), "glenfold's saved search");
    created.gSaved = gSaved;
    const done = await db().query<{ id: string }>(
      `insert into public.searches (company_id, recruiter_id, brief, source, status, filters, total, completed_at)
       values ($1, $2, 'M10 security fixture (done)', 'brief', 'done', '{"roles":["Recruiter"]}', 21, now()) returning id`,
      [G, glenfold.userId],
    );
    const gDone = done.rows[0]?.id;
    if (!gDone) throw new Error("glenfold's done search wasn't created");
    created.searches.push(gDone);
    await db().query(
      `insert into public.search_results (search_id, rank, company_id, candidate_id)
       select $1, row_number() over (order by id collate "C"), $2, id from (select id from public.candidates order by id collate "C" limit 21) c`,
      [gDone, G],
    );
    const pending = await db().query<{ id: string }>(
      `insert into public.searches (company_id, recruiter_id, brief, source) values ($1, $2, 'M10 security fixture (pending)', 'brief') returning id`,
      [G, glenfold.userId],
    );
    const gPending = pending.rows[0]?.id;
    if (!gPending) throw new Error("glenfold's pending search wasn't created");
    created.searches.push(gPending);
    c = { asterwell, glenfold, A, G, candidates: [c0, c1, c2], gList, gPerson: c0, gSaved, gDone, gPending };
    console.log(`fixtures: glenfold list with 1 person, a saved search, a done search (21 results) and a pending search`);

    const glenfoldApi = async () =>
      Promise.all(['/api/shortlists', '/api/saved-briefs', `/api/shortlists/${gList}`, `/api/search/${gDone}?page=1`, `/api/search/${gDone}?page=2`, '/api/plan'].map(async (r) => [r, (await api(glenfold.accessToken, 'GET', r)).text] as const));
    const glenfoldBefore = await companySnapshot(G);
    const glenfoldApiBefore = await glenfoldApi();
    const globalBefore = await globalSnapshot();

    // 2–4. the attacks.
    await apiAttacks(c);
    await postgrestAttacks(c);
    await anonAttacks(c);
    const quotaTenant = await createTenant('sec-quota');
    tenants.push(quotaTenant);
    await quotaAttacks(c, quotaTenant);

    // 5. nothing of glenfold's changed: in the database, byte for byte, and through its own API.
    section('glenfold afterwards: every row byte for byte, and through glenfold’s own API');
    compare('glenfold', 'glenfold rows', glenfoldBefore, await companySnapshot(G));
    const glenfoldApiAfter = await glenfoldApi();
    for (const [i, [route, text]] of glenfoldApiBefore.entries()) {
      const same = glenfoldApiAfter[i]?.[1] === text;
      record('glenfold', `as glenfold: GET ${route.replace(gList, '{list}').replace(gDone, '{search}')}`, 'identical response', same ? 'identical' : 'DIFFERENT', same);
    }
    compare('shared', 'shared data', globalBefore, await globalSnapshot());

    // 6–7.
    await secretScan(c);
    const hostileTenant = await createTenant('sec-hostile');
    tenants.push(hostileTenant);
    await setSubscription(hostileTenant.companyId, 'active');
    await hostileBriefs(hostileTenant);
  } finally {
    // Cleanup: glenfold's and asterwell's fixtures, then the throwaway companies.
    if (created.gList) await api(glenfold.accessToken, 'DELETE', `/api/shortlists/${created.gList}`);
    if (created.gSaved) await api(glenfold.accessToken, 'DELETE', `/api/saved-briefs/${created.gSaved}`);
    if (created.searches.length) await db().query('delete from public.searches where id = any($1::uuid[])', [created.searches]);
    if (c?.aList) await api(asterwell.accessToken, 'DELETE', `/api/shortlists/${c.aList}`);
    if (c?.aSaved) await api(asterwell.accessToken, 'DELETE', `/api/saved-briefs/${c.aSaved}`);
    for (const t of tenants) await t.dispose();
  }

  section('after cleanup: asterwell and glenfold are exactly as they were before the run');
  compare('cleanup', 'asterwell rows (its free search untouched)', asterwellStart, await companySnapshot(A));
  compare('cleanup', 'glenfold rows', glenfoldStart, await companySnapshot(G));
}

function summary(): void {
  const by = (v: Verdict) => rows.filter((r) => r.verdict === v);
  const areas = [...new Set(rows.map((r) => r.area))];
  console.log('\n## summary\n');
  for (const area of areas) {
    const inArea = rows.filter((r) => r.area === area);
    const failed = inArea.filter((r) => r.verdict === 'FAIL').length;
    const skipped = inArea.filter((r) => r.verdict === 'skip').length;
    console.log(`   ${pad(area, 9)} ${String(inArea.length).padStart(3)} attempts  ${failed ? `${failed} FAILED` : 'all pass'}${skipped ? `, ${skipped} skipped` : ''}`);
  }
  const failures = by('FAIL');
  console.log(`\n   ${rows.length} attempts: ${by('pass').length} pass, ${failures.length} fail, ${by('skip').length} skipped`);
  if (failures.length) {
    console.log('\n   FAILED:');
    for (const f of failures) console.log(`   - [${f.area}] ${f.attempt}: expected ${f.expected}, got ${f.got}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    // Only the error's name and message: never a request, a header or a token.
    console.error(`\nsecurity check aborted: ${err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error'}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    summary();
    await closeDb();
  });
