// npm run bench: latency of the running app (PLAN.md M12), measured from outside like a browser,
// as a throwaway paid company, so asterwell's and glenfold's rows and counters are never touched.
//   - new search: 20 distinct briefs through POST /api/search, end to end (HTTP → auth → reserve →
//     model → complete → page 1). Written for the bench, never taken from data/queries.json.
//   - paging: every page of the largest result set (plus one past the end) and page 2 of every
//     other search, through GET /api/search/{id}?page=N.
//   - --fresh=<n>: starts `make dev` n times (port 3000 must be free). After each start it waits
//     until the server answers, waits --think seconds (default 5; a person needs longer than that to
//     sign in and type), loads the app like the UI does (/api/me, /api/plan) and times one new
//     search: the first search after a start. It prints the warm-up lines and stops the server
//     again.
// Options: --base-url <url> (default http://localhost:3000)  --runs=<n> (default 1)  --fresh=<n>
//          --think=<s>  --verbose (one line per search; with --fresh, make dev's output, timed)
// Targets: paging p95 < 100 ms, new search p95 < 2.5 s, first search after a start < 3 s.
// Reads .env.local for the Supabase keys (the throwaway company) and never prints a key; the
// server reads the model key itself.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { closeDb } from '../tests/integration/helpers/db';
import { createTenant, setSubscription, type Tenant } from '../tests/integration/helpers/tenant';

const ROOT = path.resolve(import.meta.dirname, '..');
const { values: opts } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:3000' },
    runs: { type: 'string', default: '1' },
    fresh: { type: 'string', default: '0' },
    think: { type: 'string', default: '5' },
    verbose: { type: 'boolean', default: false },
  },
});
const BASE_URL = (opts['base-url'] ?? '').replace(/\/$/, '');
const RUNS = Math.max(1, Number(opts.runs) || 1);
const FRESH = Math.max(0, Number(opts.fresh) || 0);
const THINK_MS = Math.max(0, Number(opts.think) || 0) * 1000;
const PER_PAGE = 20;
const TARGET = { paging: 100, search: 2_500, first: 3_000 };

if (existsSync(path.join(ROOT, '.env.local'))) process.loadEnvFile(path.join(ROOT, '.env.local'));
for (const name of ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'DATABASE_URL']) {
  if (!process.env[name]?.trim()) {
    console.error(`${name} is not set: run \`make setup\` first. Nothing was run.`);
    process.exit(1);
  }
}

const BRIEFS = [
  'senior Python engineers in Denver',
  'engineers with 3+ years of experience',
  'frontend engineers who know Vue and Tailwind',
  'data scientists in Boston who know Pandas',
  'staff DevOps engineers who know Terraform and AWS',
  'product designers in Los Angeles with Figma',
  'recruiters who know Greenhouse and are open to work',
  'mobile engineers in Miami who know Kotlin',
  'backend engineers who used to work at Corvane',
  'marketing managers in Chicago who know SEO',
  'junior data engineers who know Airflow',
  'machine learning engineers who know CUDA',
  'full stack engineers in Atlanta with 4+ years of experience',
  'account executives who know Salesforce and Negotiation',
  'product managers who studied at MIT',
  'engineers currently at a startup in Seattle',
  'mid-level frontend engineers in Austin who know TypeScript',
  'data scientists with a master’s degree who know SQL',
  'backend engineers in New York who know Rust',
  'DevOps engineers who know Kubernetes and Datadog',
] as const;

// ---- helpers ----

type Res = { status: number; body: unknown; ms: number };

async function api(token: string, method: string, route: string, json?: unknown): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (json !== undefined) headers['content-type'] = 'application/json';
  const started = performance.now();
  const res = await fetch(`${BASE_URL}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  const ms = performance.now() - started;
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: the status tells the story
  }
  return { status: res.status, body, ms };
}

const field = (body: unknown, key: string): unknown => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined);
const errorCode = (body: unknown) => String(field(field(body, 'error'), 'code') ?? 'no error code');

/** Nearest-rank percentile, as in the e2e helpers. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}
const ms = (n: number) => `${Math.round(n)} ms`;
function line(label: string, values: number[], target: number): string {
  const p95 = percentile(values, 95);
  const verdict = p95 < target ? 'pass' : 'MISS';
  return `${label.padEnd(26)} n=${String(values.length).padEnd(4)} p50 ${ms(percentile(values, 50)).padStart(7)}   p95 ${ms(p95).padStart(7)}   max ${ms(Math.max(...values)).padStart(7)}   target p95 < ${ms(target)}: ${verdict}`;
}

async function serverAnswers(): Promise<boolean> {
  try {
    await fetch(`${BASE_URL}/api/plan`, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

const sleep = (n: number) => new Promise((resolve) => setTimeout(resolve, n));

// ---- new searches and paging against a running app ----

async function pass(tenant: Tenant, run: number): Promise<{ search: number[]; paging: number[] }> {
  const search: number[] = [];
  const done: { id: string; total: number }[] = [];
  for (const brief of BRIEFS) {
    const r = await api(tenant.accessToken, 'POST', '/api/search', { brief });
    if (r.status !== 200) throw new Error(`POST /api/search returned ${r.status} (${errorCode(r.body)}) for “${brief}”`);
    search.push(r.ms);
    if (opts.verbose) console.log(`  ${ms(r.ms).padStart(7)}  ${String(field(r.body, 'total')).padStart(5)} results  ${brief}`);
    done.push({ id: String(field(r.body, 'search_id')), total: Number(field(r.body, 'total')) });
  }
  const largest = done.reduce((a, b) => (b.total > a.total ? b : a));
  const pages: [string, number][] = [];
  for (let page = 1; page <= Math.ceil(largest.total / PER_PAGE) + 1; page += 1) pages.push([largest.id, page]);
  for (const s of done) if (s !== largest && s.total > PER_PAGE) pages.push([s.id, 2]);
  const paging: number[] = [];
  for (const [id, page] of pages) {
    const r = await api(tenant.accessToken, 'GET', `/api/search/${id}?page=${page}`);
    if (r.status !== 200) throw new Error(`GET /api/search/{id}?page=${page} returned ${r.status} (${errorCode(r.body)})`);
    paging.push(r.ms);
  }
  const totals = done.map((s) => s.total);
  console.log(`run ${run}: ${BRIEFS.length} searches (totals ${Math.min(...totals)}–${Math.max(...totals)}), ${pages.length} pages (largest search ${largest.total} results)`);
  console.log(`  ${line('new search (end to end)', search, TARGET.search)}`);
  console.log(`  ${line('paging', paging, TARGET.paging)}`);
  return { search, paging };
}

// ---- the first search after `make dev` ----

function startDev(): { child: ChildProcess; output: () => string } {
  // Its own process group, so stopping it stops make, npm and next together.
  const child = spawn('make', ['dev'], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const started = performance.now();
  // Each line is stamped with the seconds since the start, so --verbose shows where start-up time goes.
  const stamp = (d: Buffer) => d.toString().replace(/^(?=.)/gm, () => `${((performance.now() - started) / 1000).toFixed(1).padStart(5)}s  `);
  child.stdout?.on('data', (d: Buffer) => (output += stamp(d)));
  child.stderr?.on('data', (d: Buffer) => (output += stamp(d)));
  return { child, output: () => output };
}

async function stopDev(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  process.kill(-child.pid, 'SIGTERM');
  await Promise.race([exited, sleep(10_000)]);
  for (let i = 0; i < 100 && (await serverAnswers()); i += 1) await sleep(100);
}

async function firstSearch(tenant: Tenant, n: number, brief: string): Promise<number | undefined> {
  const { child, output } = startDev();
  const started = performance.now();
  try {
    while (!(await serverAnswers())) {
      if (child.exitCode !== null) throw new Error(`make dev exited with ${child.exitCode} before the server answered`);
      if (performance.now() - started > 300_000) throw new Error('the server did not answer within 5 minutes');
      await sleep(100);
    }
    const ready = performance.now() - started;
    await sleep(THINK_MS);
    await api(tenant.accessToken, 'GET', '/api/me');
    await api(tenant.accessToken, 'GET', '/api/plan');
    const r = await api(tenant.accessToken, 'POST', '/api/search', { brief });
    if (opts.verbose) {
      // make dev prints no values (DECISIONS.md, M10); lines that look like they could carry one are dropped anyway.
      for (const l of output().split('\n')) if (l.trim() && !/key|secret|token|passw|jwt|eyJ|sb_|whsec_|sk-ant-/i.test(l)) console.log(`    | ${l.slice(0, 110)}`);
    }
    const warmup = output()
      .split('\n')
      .filter((l) => l.includes('[warmup]'))
      .map((l) => l.trim())
      .join(' | ');
    const verdict = r.status !== 200 ? `FAIL (${r.status} ${errorCode(r.body)})` : r.ms < TARGET.first ? 'pass' : 'MISS';
    console.log(
      `start ${n}: server answered after ${(ready / 1000).toFixed(1)} s; first search ${ms(r.ms)} after ${THINK_MS / 1000} s (“${brief}”): ${verdict}`,
    );
    console.log(`  warm-up: ${warmup || 'no [warmup] line in the server output'}`);
    return r.status === 200 ? r.ms : undefined;
  } finally {
    await stopDev(child);
  }
}

// ---- main ----

async function main(): Promise<void> {
  console.log(`# bench against ${BASE_URL}, ${new Date().toISOString()}`);
  const running = await serverAnswers();
  if (FRESH > 0 && running) {
    console.error(`Something is already serving ${BASE_URL}; stop it before --fresh (each run starts its own \`make dev\`).`);
    process.exitCode = 1;
    return;
  }
  if (FRESH === 0 && !running) {
    console.error(`The app isn't running at ${BASE_URL}. Start it with \`make dev\`, then rerun.`);
    process.exitCode = 1;
    return;
  }
  const tenant = await createTenant('bench');
  try {
    await setSubscription(tenant.companyId, 'active');
    if (FRESH > 0) {
      const firsts: number[] = [];
      for (let n = 1; n <= FRESH; n += 1) {
        const t = await firstSearch(tenant, n, BRIEFS[(n - 1) % BRIEFS.length] ?? BRIEFS[0]);
        if (t !== undefined) firsts.push(t);
      }
      if (firsts.length) console.log(line('first search after start', firsts, TARGET.first));
      if (firsts.length < FRESH) process.exitCode = 1;
      return;
    }
    const all = { search: [] as number[], paging: [] as number[] };
    for (let run = 1; run <= RUNS; run += 1) {
      // A run is 20 searches, the most one recruiter may start in a minute (reserve_search), so
      // every later run signs in as a fresh paid recruiter.
      const t = run === 1 ? tenant : await createTenant('bench');
      try {
        if (t !== tenant) await setSubscription(t.companyId, 'active');
        const r = await pass(t, run);
        all.search.push(...r.search);
        all.paging.push(...r.paging);
      } finally {
        if (t !== tenant) await t.dispose();
      }
    }
    if (RUNS > 1) {
      console.log(`all ${RUNS} runs:`);
      console.log(`  ${line('new search (end to end)', all.search, TARGET.search)}`);
      console.log(`  ${line('paging', all.paging, TARGET.paging)}`);
    }
  } finally {
    await tenant.dispose();
    await closeDb();
  }
}

main().catch((err: unknown) => {
  console.error(`bench failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
