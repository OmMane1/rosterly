// npm run replay:stripe: sends data/stripe-events.json to the running app's webhook in file order,
// byte for byte with each event's own Stripe-Signature, and prints /api/plan for asterwell and glenfold
// after each one, next to the plan expected at that point (PLAN.md § 3.6, M8).
// Options:
//   --reset             first clear asterwell's and glenfold's subscriptions and the file's event ids, so
//                       both companies start on free (the starting point of the PLAN.md table)
//   --resign            re-sign each payload with $STRIPE_WEBHOOK_SECRET and the current time, for
//                       a server that runs with a secret other than the sample's
//   --only <events>     comma-separated 1-based positions, event ids or description prefixes
//                       (e.g. `--only asterwell-subscribe`)
//   --base-url <url>    default http://localhost:3000
// The expected column comes from a small model of the rules (each event id once; per subscription
// the newest by created, then type rank, then id; paid while any subscription is active or
// trialing), started from the database's billing state. Loads .env.local itself and prints no key.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import Stripe from 'stripe';
import { readStripeEvent } from '@/lib/server/billing/apply-event';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/lib/shared/demo-accounts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SAMPLE_SECRET = 'whsec_rosterly_sample';
const COMPANIES = DEMO_ACCOUNTS.map((a) => a.slug);

const { values: opts } = parseArgs({
  options: {
    reset: { type: 'boolean', default: false },
    resign: { type: 'boolean', default: false },
    only: { type: 'string' },
    'base-url': { type: 'string', default: 'http://localhost:3000' },
  },
});
const BASE_URL = (opts['base-url'] ?? '').replace(/\/$/, '');

if (existsSync(path.join(ROOT, '.env.local'))) process.loadEnvFile(path.join(ROOT, '.env.local'));
function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set: run \`make setup\` first${name === 'STRIPE_WEBHOOK_SECRET' ? ' (or export the secret the server uses)' : ''}.`);
    process.exit(1);
  }
  return value;
}

type FileEvent = { description: string; headers: { 'Stripe-Signature': string }; payload: string };
const file = JSON.parse(readFileSync(path.join(ROOT, 'data/stripe-events.json'), 'utf8')) as {
  events: FileEvent[];
  expected_plans_after: Record<string, string>;
};
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const idOf = (e: FileEvent) => (JSON.parse(e.payload) as { id: string }).id;

const selected = file.events
  .map((event, i) => ({ event, position: i + 1 }))
  .filter(({ event, position }) => {
    if (!opts.only) return true;
    return opts.only.split(',').some((key) => key === String(position) || key === idOf(event) || slugify(event.description).startsWith(slugify(key)));
  });
if (selected.length === 0) {
  console.error(`--only ${opts.only} matches no event. Events: ${file.events.map((e, i) => `${i + 1} ${slugify(e.description)}`).join(', ')}`);
  process.exit(1);
}

// ---- the expected plans: a model of the rules, independent of the SQL that implements them ----

type Key = [created: number, rank: number, id: string];
type Model = { seen: Set<string>; subscriptions: Map<string, { company: string; status: string; key: Key }>; slugs: Set<string> };

// Mirrors private.stripe_event_rank (billing migration).
function rank(type: string): number {
  if (type === 'customer.subscription.deleted') return 4;
  if (type === 'customer.subscription.created') return 1;
  if (type.startsWith('customer.subscription.')) return 3;
  if (type.startsWith('checkout.session.')) return 2;
  return 0;
}
function newer(a: Key, b: Key): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return Buffer.compare(Buffer.from(a[2]), Buffer.from(b[2])) > 0; // collate "C": byte order
}
function applyToModel(model: Model, event: unknown): void {
  const r = readStripeEvent(event);
  if (!r || model.seen.has(r.id)) return;
  model.seen.add(r.id);
  if (!r.change) return;
  const current = model.subscriptions.get(r.change.id);
  const named = r.change.company?.toLowerCase();
  const company = named && model.slugs.has(named) ? named : current?.company;
  if (!company) return;
  const key: Key = [r.created, rank(r.type), r.id];
  if (current && !newer(key, current.key)) return;
  model.subscriptions.set(r.change.id, { company, status: r.change.status, key });
}
const modelPlan = (model: Model, company: string) =>
  [...model.subscriptions.values()].some((s) => s.company === company && ['active', 'trialing'].includes(s.status)) ? 'paid' : 'free';

// ---- run ----

const pool = new pg.Pool({ connectionString: env('DATABASE_URL'), max: 1 });

async function main(): Promise<number> {
  const fileIds = [...new Set(file.events.map(idOf))];
  const { rows: companies } = await pool.query<{ id: string; slug: string }>('select id, slug from public.companies');
  const companyIds = companies.filter((c) => COMPANIES.includes(c.slug as (typeof COMPANIES)[number])).map((c) => c.id);

  if (opts.reset) {
    const subs = await pool.query('delete from public.subscriptions where company_id = any($1::uuid[])', [companyIds]);
    const events = await pool.query('delete from public.processed_stripe_events where event_id = any($1)', [fileIds]);
    console.log(`reset: removed ${subs.rowCount} subscription(s) of ${COMPANIES.join(' and ')} and ${events.rowCount} processed event id(s) from the file\n`);
  }

  const model: Model = { seen: new Set(), subscriptions: new Map(), slugs: new Set(companies.map((c) => c.slug)) };
  const seen = await pool.query<{ event_id: string }>('select event_id from public.processed_stripe_events where event_id = any($1)', [fileIds]);
  for (const r of seen.rows) model.seen.add(r.event_id);
  const stored = await pool.query<{ stripe_subscription_id: string; slug: string; status: string; last_event_created: string; last_event_type: string; last_event_id: string }>(
    `select s.stripe_subscription_id, c.slug, s.status, s.last_event_created, s.last_event_type, s.last_event_id
     from public.subscriptions s join public.companies c on c.id = s.company_id where s.company_id = any($1::uuid[])`,
    [companyIds],
  );
  for (const s of stored.rows) {
    model.subscriptions.set(s.stripe_subscription_id, { company: s.slug, status: s.status, key: [Number(s.last_event_created), rank(s.last_event_type), s.last_event_id] });
  }

  // /api/plan is read as each company's seeded recruiter.
  const tokens = new Map<string, string>();
  for (const a of DEMO_ACCOUNTS) {
    const client = createClient(env('SUPABASE_URL'), env('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.signInWithPassword({ email: a.email, password: DEMO_PASSWORD });
    if (error) throw new Error(`sign-in as ${a.email} failed: ${error.message}`);
    tokens.set(a.slug, data.session.access_token);
  }

  async function planOf(slug: string): Promise<{ plan: string; searches_remaining: number | null }> {
    const res = await fetch(`${BASE_URL}/api/plan`, { headers: { authorization: `Bearer ${tokens.get(slug) ?? ''}` } });
    if (!res.ok) throw new Error(`GET /api/plan as ${slug} returned ${res.status}`);
    return (await res.json()) as { plan: string; searches_remaining: number | null };
  }
  const show = (p: { plan: string; searches_remaining: number | null }) => (p.plan === 'paid' ? 'paid' : `free (${p.searches_remaining} left)`);

  const secret = opts.resign ? env('STRIPE_WEBHOOK_SECRET') : undefined;
  if (opts.resign) console.log(`re-signing every payload with $STRIPE_WEBHOOK_SECRET${secret === SAMPLE_SECRET ? ' (the sample secret)' : ''} at the current time\n`);

  const columns: [string, number][] = [
    ['#', 2],
    ['event id', 15],
    ['type', 29],
    ['company', 7],
    ['status', 10],
    ['created (UTC)', 20],
    ['HTTP', 4],
    ['asterwell /api/plan', 15],
    ['glenfold /api/plan', 16],
    ['expected', 11],
    ['', 4],
  ];
  const line = (cells: string[]) => console.log(cells.map((c, i) => c.padEnd(columns[i]?.[1] ?? 0)).join('  ').trimEnd());
  line(columns.map(([name]) => name));
  line(columns.map(([, width]) => '-'.repeat(width)));

  const before = await Promise.all(COMPANIES.map(planOf));
  line(['', '(before)', '', '', '', '', '', show(before[0] ?? { plan: '?', searches_remaining: null }), show(before[1] ?? { plan: '?', searches_remaining: null }), COMPANIES.map((c) => modelPlan(model, c)).join(' / '), '']);

  let failures = 0;
  let refused = 0;
  for (const { event, position } of selected) {
    const parsed = JSON.parse(event.payload) as { id: string; type: string; created: number; data?: { object?: { status?: string; metadata?: { company?: string } } } };
    const signature = secret ? Stripe.webhooks.generateTestHeaderString({ payload: event.payload, secret }) : event.headers['Stripe-Signature'];
    const res = await fetch(`${BASE_URL}/api/billing/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: event.payload,
    });
    await res.arrayBuffer();
    applyToModel(model, parsed);

    const actual = await Promise.all(COMPANIES.map(planOf));
    const expected = COMPANIES.map((c) => modelPlan(model, c));
    const pass = res.status === 200 && actual.every((p, i) => p.plan === expected[i]);
    if (!pass) failures++;
    if (res.status === 400) refused++;
    line([
      String(position),
      parsed.id.replace(/^evt_/, ''),
      parsed.type,
      parsed.data?.object?.metadata?.company ?? '—',
      parsed.data?.object?.status ?? '—',
      new Date(parsed.created * 1000).toISOString().replace('.000', ''),
      String(res.status),
      show(actual[0] ?? { plan: '?', searches_remaining: null }),
      show(actual[1] ?? { plan: '?', searches_remaining: null }),
      expected.join(' / '),
      pass ? 'PASS' : 'FAIL',
    ]);
  }

  if (selected.length === file.events.length) {
    const final = await Promise.all(COMPANIES.map(planOf));
    const wanted = COMPANIES.map((c) => file.expected_plans_after[c]);
    const ok = final.every((p, i) => p.plan === wanted[i]);
    if (!ok) failures++;
    console.log(`\nfinal: ${COMPANIES.map((c, i) => `${c} ${final[i]?.plan}`).join(', ')}; the file expects ${COMPANIES.map((c, i) => `${c} ${wanted[i]}`).join(', ')}: ${ok ? 'PASS' : 'FAIL'}`);
  }
  if (refused > 0 && !opts.resign) {
    console.log('\nThe server refused the sample signatures: it runs with a STRIPE_WEBHOOK_SECRET other than the sample one. Rerun with --resign.');
  }
  console.log(failures === 0 ? '\nall rows pass' : `\n${failures} row(s) failed`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    if (err instanceof TypeError && /fetch failed/.test(err.message)) console.error(`Is the app running at ${BASE_URL}? Start it with \`make dev\`.`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
