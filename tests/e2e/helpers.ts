// HTTP helpers for the API contract tests. They call the running app (`make dev`, or E2E_BASE_URL)
// as real recruiters. Companies come from the integration helpers: throwaway tenants, so asterwell's and
// glenfold's rows are never touched.
import { db } from '../integration/helpers/db';

export const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/** The app calls the model with its own environment; this mirrors it for skipping (CLAUDE.md). */
export const HAS_MODEL_KEY = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

export type Res = { status: number; body: unknown; ms: number };

type Options = { token?: string; json?: unknown; raw?: string; headers?: Record<string, string> };

export async function call(method: string, path: string, opts: Options = {}): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined = opts.raw;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['content-type'] = 'application/json';
  }
  const started = performance.now();
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body });
  const text = await res.text();
  const ms = performance.now() - started;
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: keep the text so a failing assertion shows it
  }
  return { status: res.status, body: parsed, ms };
}

/** Calls as one recruiter. */
export function as(token: string) {
  return {
    get: (path: string) => call('GET', path, { token }),
    post: (path: string, json?: unknown) => call('POST', path, { token, json }),
    patch: (path: string, json: unknown) => call('PATCH', path, { token, json }),
    del: (path: string) => call('DELETE', path, { token }),
    raw: (method: string, path: string, raw: string) => call(method, path, { token, raw, headers: { 'content-type': 'application/json' } }),
  };
}
export type Caller = ReturnType<typeof as>;

/** Fails fast, with the fix, when nothing is serving the app. */
export async function requireApp(): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/plan`);
  } catch {
    throw new Error(`The app isn't running at ${BASE_URL}. Start it with \`make dev\` (or set E2E_BASE_URL), then rerun.`);
  }
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

export const summary = (values: number[]) =>
  `n=${values.length} p50=${percentile(values, 50).toFixed(0)}ms p95=${percentile(values, 95).toFixed(0)}ms max=${Math.max(...values).toFixed(0)}ms`;

/** The ranked ids the database itself returns for these filters (the oracle for paging). */
export async function matchOrder(filters: unknown): Promise<string[]> {
  const { rows } = await db().query<{ candidate_id: string }>('select candidate_id from private.match_candidates($1::jsonb) order by rank', [
    JSON.stringify(filters),
  ]);
  return rows.map((r) => r.candidate_id);
}

/** Every row a company owns, for "nothing changed" checks. */
export async function companyRows(companyId: string) {
  const rows = async (sql: string) => (await db().query(sql, [companyId])).rows;
  return {
    shortlists: await rows('select id, name, created_at, updated_at from public.shortlists where company_id = $1 order by id'),
    people: await rows('select shortlist_id, candidate_id, added_at from public.shortlist_people where company_id = $1 order by 1, 2'),
    saved: await rows('select id, brief, filters, created_at from public.saved_briefs where company_id = $1 order by id'),
    searches: await rows('select id, status, total, filters from public.searches where company_id = $1 order by id'),
    results: await rows('select search_id, rank, candidate_id from public.search_results where company_id = $1 order by 1, 2'),
    usage: await rows('select searches_used from public.company_usage where company_id = $1'),
  };
}

export async function searchesUsed(companyId: string): Promise<number> {
  const { rows } = await db().query<{ searches_used: number }>('select searches_used from public.company_usage where company_id = $1', [companyId]);
  return rows[0]?.searches_used ?? NaN;
}
