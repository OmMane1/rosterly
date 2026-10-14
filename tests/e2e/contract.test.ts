// The API contract (PLAN.md § 3.7, M7 acceptance), against the running app: every route's shape and
// status codes, the 401 → 403 → 400 → 402 order, the free-plan burst, paging coverage and speed,
// cross-company isolation (404, with the other company's rows unchanged) and the Stripe webhook.
// Needs `make dev` (or E2E_BASE_URL) and local Supabase. The tests that make the app call the
// model are skipped, and say so, when ANTHROPIC_API_KEY is unset.
import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEMO_ACCOUNTS } from '@/lib/shared/demo-accounts';
import { closeDb, db } from '../integration/helpers/db';
import { publishableKey, signIn, type Session } from '../integration/helpers/supabase';
import { createTenant, createUser, setSubscription, type Tenant } from '../integration/helpers/tenant';
import { as, call, companyRows, HAS_MODEL_KEY, matchOrder, percentile, requireApp, searchesUsed, summary, type Caller, type Res } from './helpers';

// ---- the contract, written out here rather than imported, so the tests check the spec ----

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'a timestamp');
const Card = z.strictObject({
  id: z.string().min(1),
  full_name: z.string(),
  avatar_url: z.string(),
  headline: z.string(),
  current_title: z.string(),
  current_company: z.string(),
  current_company_logo_url: z.string(),
  role: z.string(),
  seniority: z.enum(['junior', 'mid', 'senior', 'staff']),
  years_experience: z.int(),
  location: z.strictObject({ city: z.string(), state: z.string(), country: z.string() }),
  open_to_work: z.boolean(),
  skills: z.array(z.string()),
});
const FiltersObject = z.record(z.string(), z.unknown());
const SearchBody = z.strictObject({
  search_id: z.uuid(),
  filters: FiltersObject,
  total: z.int().min(0),
  results: z.array(Card).max(20),
  searches_remaining: z.int().min(0).nullable(),
});
const PageBody = z.strictObject({
  search_id: z.uuid(),
  brief: z.string(),
  filters: FiltersObject,
  page: z.int().min(1),
  per_page: z.literal(20),
  total: z.int().min(0),
  results: z.array(Card).max(20),
});
const PlanBody = z.strictObject({ plan: z.enum(['free', 'paid']), searches_remaining: z.int().min(0).nullable() });
const MeBody = z.strictObject({ email: z.string().nullable(), company: z.strictObject({ slug: z.string(), name: z.string() }) });
const ErrorBody = z.strictObject({ error: z.strictObject({ code: z.string().min(1), message: z.string().min(1) }) });
const LimitBody = ErrorBody.extend({ plan: z.literal('free'), searches_remaining: z.literal(0) });
const ShortlistBody = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  created_at: Timestamp,
  updated_at: Timestamp,
  people_count: z.int().min(0),
  people: z.array(Card),
});
const RenamedBody = z.strictObject({ id: z.uuid(), name: z.string() });
const SavedBody = z.strictObject({ id: z.uuid(), brief: z.string(), filters: FiltersObject, created_at: Timestamp });
const IdBody = z.strictObject({ id: z.uuid() });
const OkBody = z.strictObject({ ok: z.literal(true) });

function expectBody<T>(res: Res, status: number, schema: z.ZodType<T>): T {
  expect(res.status, `body: ${JSON.stringify(res.body)?.slice(0, 400)}`).toBe(status);
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) throw new Error(`${z.prettifyError(parsed.error)}\nbody: ${JSON.stringify(res.body)?.slice(0, 400)}`);
  return parsed.data;
}
function expectError(res: Res, status: number, code?: string) {
  const body = expectBody(res, status, ErrorBody);
  if (code) expect(body.error.code).toBe(code);
  return body;
}

// ---- data and fixtures ----

type Candidate = { id: string; experiences: unknown[] } & Record<string, unknown>;
const CANDIDATES = JSON.parse(readFileSync('data/candidates.json', 'utf8')) as Candidate[];
const CARD_KEYS = Object.keys(Card.shape);
const cardOf = (id: string) => {
  const c = CANDIDATES.find((x) => x.id === id);
  if (!c) throw new Error(`no candidate ${id}`);
  return Object.fromEntries(CARD_KEYS.map((k) => [k, c[k]]));
};

const NIL = '00000000-0000-4000-8000-000000000000'; // a well-formed id nobody has
const SWIFT = { roles: ['Mobile Engineer'], skills_all: ['Swift'] }; // 199 people, 10 pages
const WIDE = { years_min: 1 }; // ~4,700 people, ~235 pages
const MODEL = HAS_MODEL_KEY ? '' : ' (skipped: ANTHROPIC_API_KEY is unset)';

let free: Tenant; // a fresh free company: input checks, the refine burst, then life at 0 searches left
let burst: Tenant; // a fresh free company for the 20-request POST /api/search burst
let paid: Tenant; // a paid company: large searches, shortlists, saved briefs, latency
let owner: Tenant; // owns the rows the cross-company attempts target
let outsider: Session & { dispose: () => Promise<void> }; // signed in, but not a recruiter
let F: Caller, B: Caller, P: Caller, O: Caller, X: Caller;
let freeSearch = ''; // free's one search (SWIFT), paged with 0 searches left

beforeAll(async () => {
  await requireApp();
  if (!HAS_MODEL_KEY) console.warn('[e2e] ANTHROPIC_API_KEY is unset: the tests that call the model are skipped.');
  [free, burst, paid, owner, outsider] = await Promise.all([
    createTenant('e2e-free'),
    createTenant('e2e-burst'),
    createTenant('e2e-paid'),
    createTenant('e2e-owner'),
    createUser('e2e-outsider'),
  ]);
  await setSubscription(paid.companyId, 'active');
  [F, B, P, O, X] = [free, burst, paid, owner, outsider].map((t) => as(t.accessToken)) as [Caller, Caller, Caller, Caller, Caller];
});

afterAll(async () => {
  await Promise.all([free, burst, paid, owner, outsider].map((t) => t?.dispose()));
  await closeDb();
});

// ---- auth ----

const ROUTES: [string, string, unknown?][] = [
  ['POST', '/api/search', { brief: 'backend engineers' }],
  ['POST', '/api/search/refine', { brief: 'x', filters: SWIFT, source: 'edit' }],
  ['GET', `/api/search/${NIL}?page=1`],
  ['GET', '/api/people/cand_0001'],
  ['GET', '/api/shortlists'],
  ['POST', '/api/shortlists', { name: 'x' }],
  ['GET', `/api/shortlists/${NIL}`],
  ['PATCH', `/api/shortlists/${NIL}`, { name: 'x' }],
  ['DELETE', `/api/shortlists/${NIL}`],
  ['POST', `/api/shortlists/${NIL}/people/cand_0001`],
  ['DELETE', `/api/shortlists/${NIL}/people/cand_0001`],
  ['GET', '/api/saved-briefs'],
  ['POST', '/api/saved-briefs', { brief: 'x', filters: {} }],
  ['DELETE', `/api/saved-briefs/${NIL}`],
  ['GET', '/api/plan'],
  ['GET', '/api/me'],
];

describe('auth: 401 without a valid token, 403 for a non-recruiter, both before the body is read', () => {
  it.each(ROUTES)('%s %s → 401 without a valid token', async (method, path, json) => {
    const tampered = (() => {
      // Same signature, payload claiming to be another user.
      const [h, p, s] = owner.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(p ?? '', 'base64url').toString()) as Record<string, unknown>;
      return [h, Buffer.from(JSON.stringify({ ...claims, sub: paid.userId })).toString('base64url'), s].join('.');
    })();
    for (const authorization of [undefined, 'Bearer', 'Bearer not-a-jwt', `Basic ${owner.accessToken}`, `Bearer ${publishableKey()}`, `Bearer ${tampered}`]) {
      const res = await call(method, path, { json, headers: authorization ? { authorization } : {} });
      expectError(res, 401, 'unauthorized');
    }
  });

  it.each(ROUTES)('%s %s → 403 as a signed-in user with no company', async (method, path, json) => {
    expectError(await call(method, path, { token: outsider.accessToken, json }), 403, 'forbidden');
  });

  it('401 and 403 come before a bad body', async () => {
    expectError(await call('POST', '/api/search', { raw: 'not json' }), 401);
    expectError(await X.raw('POST', '/api/search', 'not json'), 403);
    expectError(await X.post('/api/search', { brief: '' }), 403);
  });
});

// ---- plan ----

describe('GET /api/plan', () => {
  it('free with 1 search left on a fresh company; paid with null', async () => {
    expect(expectBody(await F.get('/api/plan'), 200, PlanBody)).toEqual({ plan: 'free', searches_remaining: 1 });
    expect(expectBody(await P.get('/api/plan'), 200, PlanBody)).toEqual({ plan: 'paid', searches_remaining: null });
  });

  it.each(DEMO_ACCOUNTS.map((a) => [a.slug, a.email]))('the seeded %s recruiter signs in and reads its plan and lists', async (_, email) => {
    const caller = as((await signIn(email)).accessToken);
    expectBody(await caller.get('/api/plan'), 200, PlanBody);
    expectBody(await caller.get('/api/shortlists'), 200, z.array(ShortlistBody));
    expectBody(await caller.get('/api/saved-briefs'), 200, z.array(SavedBody));
  });
});

// ---- me ----

describe('GET /api/me', () => {
  it('names the signed-in recruiter and their own company', async () => {
    const me = expectBody(await F.get('/api/me'), 200, MeBody);
    expect(me.company).toEqual({ slug: free.slug, name: free.slug }); // createTenant names the company after its slug
    expect(me.email).toMatch(/^e2e-free-.+@tenant\.test$/);
  });

  it.each(DEMO_ACCOUNTS.map((a) => [a.slug, a.email, a.name]))('the seeded %s recruiter sees its company name', async (slug, email, name) => {
    const caller = as((await signIn(email)).accessToken);
    expect(expectBody(await caller.get('/api/me'), 200, MeBody)).toEqual({ email, company: { slug, name } });
  });
});

// ---- billing ----

describe('POST /api/billing/events', () => {
  // The app and this test read the same .env.local, so they share the secret; a server's own secret
  // is covered by tests/integration/billing.test.ts.
  const SECRET = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const NO_SECRET = SECRET ? '' : ' (skipped: STRIPE_WEBHOOK_SECRET is unset)';
  const Received = z.strictObject({ received: z.literal(true) });
  let billed: Tenant;
  const ids: string[] = [];
  const payload = (type: string, created: number, status: string) => {
    const id = `evt_e2e_${billed.slug}_${ids.length}`;
    ids.push(id);
    return JSON.stringify({
      id,
      object: 'event',
      type,
      created,
      data: { object: { id: `sub_e2e_${billed.slug}`, object: 'subscription', status, metadata: { company: billed.slug } } },
    });
  };
  const post = (body: string, signature?: string) =>
    call('POST', '/api/billing/events', { raw: body, headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) } });

  beforeAll(async () => {
    billed = await createTenant('e2e-billing');
  });
  afterAll(async () => {
    await billed?.dispose();
    await db().query('delete from public.processed_stripe_events where event_id = any($1)', [ids]);
  });

  it('needs no recruiter token, and a missing or bad signature is a 400', async () => {
    const body = payload('customer.subscription.created', 1_800_000_000, 'active');
    expectError(await post(body), 400, 'missing_signature');
    expectError(await post(body, 't=1800000000,v1=00'), 400, 'invalid_signature');
    expectError(await post(body, Stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_not_the_servers' })), 400, 'invalid_signature');
    expect(expectBody(await as(billed.accessToken).get('/api/plan'), 200, PlanBody).plan).toBe('free');
  });

  it.skipIf(!SECRET)(`a signed event is a 200 {received:true}, repeats included, and /api/plan follows it${NO_SECRET}`, async () => {
    const sign = (body: string) => Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET ?? '' });
    const billing = as(billed.accessToken);
    const subscribe = payload('customer.subscription.created', 1_800_000_000, 'active');
    expectBody(await post(subscribe, sign(subscribe)), 200, Received);
    expect(expectBody(await billing.get('/api/plan'), 200, PlanBody)).toEqual({ plan: 'paid', searches_remaining: null });
    expectBody(await post(subscribe, sign(subscribe)), 200, Received);
    const cancel = payload('customer.subscription.deleted', 1_800_000_100, 'canceled');
    expectBody(await post(cancel, sign(cancel)), 200, Received);
    expect(expectBody(await billing.get('/api/plan'), 200, PlanBody)).toEqual({ plan: 'free', searches_remaining: 1 });
    // The original "subscribed" event again, after the cancellation: still free.
    expectBody(await post(subscribe, sign(subscribe)), 200, Received);
    expect(expectBody(await billing.get('/api/plan'), 200, PlanBody).plan).toBe('free');
    const unknown = payload('invoice.paid', 1_800_000_200, 'paid');
    expectBody(await post(unknown, sign(unknown)), 200, Received);
    expect(expectBody(await billing.get('/api/plan'), 200, PlanBody).plan).toBe('free');
  });
});

// ---- new searches ----

describe('POST /api/search: a bad brief is a 400 and never uses the free search', () => {
  it.each([
    ['no brief', {}],
    ['an empty brief', { brief: '' }],
    ['a blank brief', { brief: '  \n\t ' }],
    ['control characters only', { brief: '\u0000\u0001\u007f' }],
    ['1,001 characters', { brief: 'x'.repeat(1001) }],
    ['a number', { brief: 42 }],
    ['null', { brief: null }],
  ])('%s → 400 invalid_brief', async (_, body) => {
    expectError(await F.post('/api/search', body), 400, 'invalid_brief');
  });

  it.each([
    ['not JSON', 'brief=backend', 'invalid_json'],
    ['a JSON array', '["backend engineers"]', 'invalid_body'],
    ['JSON null', 'null', 'invalid_body'],
    ['a body over 32 KB', JSON.stringify({ brief: 'x'.repeat(40_000) }), 'body_too_large'],
  ])('%s → 400 %s', async (_, raw, code) => {
    expectError(await F.raw('POST', '/api/search', raw), 400, code);
  });

  it('none of that used the search', async () => {
    expect(expectBody(await F.get('/api/plan'), 200, PlanBody)).toEqual({ plan: 'free', searches_remaining: 1 });
    expect(await searchesUsed(free.companyId)).toBe(0);
  });
});

describe('POST /api/search/refine: the same quota, the recruiter’s own filters, no model', () => {
  it.each([
    ['a value outside the vocabulary', { brief: 'x', filters: { roles: ['Wizard'] }, source: 'edit' }, 'invalid_filters'],
    ['an unknown filter key', { brief: 'x', filters: { role: ['Mobile Engineer'] }, source: 'edit' }, 'invalid_filters'],
    ['filters that are an array', { brief: 'x', filters: [], source: 'edit' }, 'invalid_filters'],
    ['no filters', { brief: 'x', source: 'edit' }, 'invalid_filters'],
    ['source "brief"', { brief: 'x', filters: SWIFT, source: 'brief' }, 'invalid_request'],
    ['no brief', { filters: SWIFT, source: 'edit' }, 'invalid_request'],
  ])('%s → 400 %s', async (_, body, code) => {
    expectError(await F.post('/api/search/refine', body), 400, code);
    expect(await searchesUsed(free.companyId)).toBe(0);
  });

  it('20 concurrent refines on a free company → exactly one 200 and nineteen 402s', async () => {
    const all = await Promise.all(Array.from({ length: 20 }, () => F.post('/api/search/refine', { brief: 'iOS developers', filters: SWIFT, source: 'edit' })));
    const ok = all.filter((r) => r.status === 200);
    const limited = all.filter((r) => r.status === 402);
    expect([ok.length, limited.length]).toEqual([1, 19]);
    for (const r of limited) expectBody(r, 402, LimitBody);

    const [winner] = ok;
    const body = expectBody(winner as Res, 200, SearchBody);
    const expected = await matchOrder(SWIFT);
    expect(body).toMatchObject({ filters: SWIFT, total: expected.length, searches_remaining: 0 });
    expect(body.results.map((c) => c.id)).toEqual(expected.slice(0, 20));
    freeSearch = body.search_id;
    expect(expectBody(await F.get('/api/plan'), 200, PlanBody)).toEqual({ plan: 'free', searches_remaining: 0 });
    expect(await searchesUsed(free.companyId)).toBe(1);
  });
});

describe('POST /api/search/refine: one recruiter starts at most 20 searches a minute', () => {
  let pace: Tenant; // paid, so only the pace limits it

  beforeAll(async () => {
    pace = await createTenant('e2e-pace');
    await setSubscription(pace.companyId, 'active');
  });

  afterAll(async () => {
    await pace?.dispose();
  });

  it('21 concurrent refines on a paid company → twenty 200s and one 429 that says when to retry', async () => {
    const R = as(pace.accessToken);
    const all = await Promise.all(Array.from({ length: 21 }, () => R.post('/api/search/refine', { brief: 'iOS developers', filters: SWIFT, source: 'edit' })));
    const ok = all.filter((r) => r.status === 200);
    const limited = all.filter((r) => r.status === 429);
    expect([ok.length, limited.length], JSON.stringify(all.map((r) => r.status))).toEqual([20, 1]);
    const [refused] = limited;
    expectError(refused as Res, 429, 'rate_limited');
    expect(refused?.headers.get('retry-after')).toBe('60');
    expect(await searchesUsed(pace.companyId)).toBe(20);
  });
});

describe('POST /api/search: 20 concurrent requests on a fresh free company', () => {
  it.skipIf(!HAS_MODEL_KEY)(`exactly one 200 and nineteen 402s, and the 402s don't wait for the model${MODEL}`, async () => {
    const all = await Promise.all(Array.from({ length: 20 }, () => B.post('/api/search', { brief: 'devops engineers who know Terraform' })));
    const ok = all.filter((r) => r.status === 200);
    const limited = all.filter((r) => r.status === 402);
    expect([ok.length, limited.length], JSON.stringify(all.map((r) => r.status))).toEqual([1, 19]);
    for (const r of limited) expectBody(r, 402, LimitBody);

    const winner = ok[0] as Res;
    const body = expectBody(winner, 200, SearchBody);
    expect(Object.keys(body).sort()).toEqual(['filters', 'results', 'search_id', 'searches_remaining', 'total']);
    expect(body.searches_remaining).toBe(0);
    expect(body.total).toBeGreaterThan(0);
    expect(body.results.map((c) => c.id)).toEqual((await matchOrder(body.filters)).slice(0, 20));
    expect(Math.max(...limited.map((r) => r.ms))).toBeLessThan(winner.ms);
    expect(await searchesUsed(burst.companyId)).toBe(1);
    console.log(`[e2e] burst: one 200 in ${winner.ms.toFixed(0)}ms; nineteen 402s ${summary(limited.map((r) => r.ms))}`);
  });
});

describe('with no searches left, a bad request is still a 400 before the 402', () => {
  it('bad brief, bad body or bad filters → 400', async () => {
    expectError(await F.post('/api/search', { brief: '' }), 400, 'invalid_brief');
    expectError(await F.raw('POST', '/api/search', '{"brief":'), 400, 'invalid_json');
    expectError(await F.post('/api/search/refine', { brief: 'x', filters: { roles: ['Wizard'] }, source: 'edit' }), 400, 'invalid_filters');
  });

  it('a valid brief → 402 at once, without calling the model', async () => {
    const res = await F.post('/api/search', { brief: 'backend engineers in Denver' });
    expectBody(res, 402, LimitBody);
    expect(res.ms).toBeLessThan(1000);
    expectBody(await F.post('/api/search/refine', { brief: 'x', filters: SWIFT, source: 'saved' }), 402, LimitBody);
    expect(await searchesUsed(free.companyId)).toBe(1);
  });
});

// ---- paging ----

describe('GET /api/search/{id}?page=N', () => {
  it('pages the free search with 0 searches left; every result once, in rank order; never counts', async () => {
    const expected = await matchOrder(SWIFT);
    const pages = Math.ceil(expected.length / 20);
    const ids: string[] = [];
    for (let n = 1; n <= pages + 1; n++) {
      const body = expectBody(await F.get(`/api/search/${freeSearch}?page=${n}`), 200, PageBody);
      expect(body).toMatchObject({ search_id: freeSearch, brief: 'iOS developers', filters: SWIFT, page: n, per_page: 20, total: expected.length });
      expect(body.results).toHaveLength(n <= pages ? Math.min(20, expected.length - (n - 1) * 20) : 0);
      ids.push(...body.results.map((c) => c.id));
    }
    expect(ids).toEqual(expected);
    expect(expectBody(await F.get('/api/plan'), 200, PlanBody)).toEqual({ plan: 'free', searches_remaining: 0 });
    expect(await searchesUsed(free.companyId)).toBe(1);
  });

  it('page defaults to 1; far past the end is 200 with no results', async () => {
    const first = expectBody(await F.get(`/api/search/${freeSearch}`), 200, PageBody);
    expect(first.page).toBe(1);
    expect(first).toEqual(expectBody(await F.get(`/api/search/${freeSearch}?page=1`), 200, PageBody));
    expect(expectBody(await F.get(`/api/search/${freeSearch}?page=10000`), 200, PageBody).results).toEqual([]);
  });

  it.each(['0', '-1', '1.5', 'abc', '', '10001', '1e3', '%201'])('page=%j → 400 invalid_page', async (page) => {
    expectError(await F.get(`/api/search/${freeSearch}?page=${page}`), 400, 'invalid_page');
  });

  it('an unknown id, a malformed id, or another company’s search → 404', async () => {
    expectError(await F.get(`/api/search/${NIL}?page=1`), 404, 'not_found');
    expectError(await F.get('/api/search/not-a-uuid?page=1'), 404, 'not_found');
    expectError(await P.get(`/api/search/${freeSearch}?page=1`), 404, 'not_found');
  });

  it('a large search pages to the end with every result exactly once; paging p95 is well under 300 ms', async () => {
    const created = expectBody(
      await P.post('/api/search/refine', { brief: 'anyone with at least a year of experience', filters: WIDE, source: 'edit' }),
      200,
      SearchBody,
    );
    const expected = await matchOrder(WIDE);
    expect(created.total).toBe(expected.length);
    expect(created.total).toBeGreaterThan(4000);
    const usedBefore = await searchesUsed(paid.companyId);

    const pages = Math.ceil(created.total / 20);
    const ids: string[] = [];
    const ms: number[] = [];
    for (let n = 1; n <= pages + 1; n++) {
      const res = await P.get(`/api/search/${created.search_id}?page=${n}`);
      const body = expectBody(res, 200, PageBody);
      expect([body.page, body.total]).toEqual([n, created.total]);
      ids.push(...body.results.map((c) => c.id));
      ms.push(res.ms);
    }
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toHaveLength(created.total); // full coverage
    expect(ids).toEqual(expected); // in rank order
    expect(created.results.map((c) => c.id)).toEqual(ids.slice(0, 20));
    expect(await searchesUsed(paid.companyId)).toBe(usedBefore);

    console.log(`[e2e] paging ${pages + 1} pages of a ${created.total}-result search: ${summary(ms)}`);
    expect(percentile(ms, 95)).toBeLessThan(100);
  });
});

describe('POST /api/search with the model', () => {
  it.skipIf(!HAS_MODEL_KEY)(`page 1 is the top 20 and paging to the end returns exactly the matching set${MODEL}`, async () => {
    const created = expectBody(await P.post('/api/search', { brief: 'data engineers who know Spark' }), 200, SearchBody);
    expect(created.searches_remaining).toBeNull();
    const expected = await matchOrder(created.filters);
    expect(created.total).toBe(expected.length);
    expect(created.total).toBeGreaterThan(20);
    const ids: string[] = [];
    for (let n = 1; n <= Math.ceil(created.total / 20); n++) {
      ids.push(...expectBody(await P.get(`/api/search/${created.search_id}?page=${n}`), 200, PageBody).results.map((c) => c.id));
    }
    expect(ids).toEqual(expected);
    expect(created.results.map((c) => c.id)).toEqual(ids.slice(0, 20));
  });

  it.skipIf(!HAS_MODEL_KEY)(`new search end to end (auth, reserve, model, ranking, page 1)${MODEL}`, async () => {
    const briefs = [
      'frontend engineers in Denver who know TypeScript',
      'recruiters in Miami who are open to work',
      'ex-Corvane backend engineers',
      'staff devops engineers with Terraform',
      'product managers with an MBA',
      'junior mobile engineers in Seattle',
      'marketing managers in Los Angeles',
      'senior data scientists who studied at MIT',
    ];
    const ms: number[] = [];
    for (const brief of briefs) {
      const res = await P.post('/api/search', { brief });
      expectBody(res, 200, SearchBody);
      ms.push(res.ms);
    }
    console.log(`[e2e] new search end to end: ${summary(ms)}`);
    expect(percentile(ms, 50)).toBeLessThan(3000);
  });
});

// ---- candidates ----

describe('GET /api/people/{id}', () => {
  it('returns the candidate exactly as in candidates.json', async () => {
    const multi = CANDIDATES.filter((c) => c.experiences.length === 4).slice(0, 3);
    for (const c of [CANDIDATES[0] as Candidate, ...multi]) {
      const res = await P.get(`/api/people/${c.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual(c);
      expect(Object.keys(res.body as object)).toEqual(Object.keys(c));
    }
  });

  it.each(['cand_9999', 'x'.repeat(65), "cand_0001'%20or%20'1'='1"])('%s → 404', async (id) => {
    expectError(await P.get(`/api/people/${id}`), 404, 'not_found');
  });
});

// ---- shortlists ----

describe('shortlists', () => {
  let list = '';

  it('POST creates a list → { id }, with the name trimmed to one line', async () => {
    list = expectBody(await P.post('/api/shortlists', { name: '  Backend \n hires ' }), 200, IdBody).id;
    expect(expectBody(await P.get(`/api/shortlists/${list}`), 200, ShortlistBody)).toMatchObject({ id: list, name: 'Backend hires', people_count: 0, people: [] });
    expectBody(await P.post('/api/shortlists', { name: 'n'.repeat(80) }), 200, IdBody);
  });

  it.each([
    ['no name', {}],
    ['an empty name', { name: '' }],
    ['a blank name', { name: ' \n ' }],
    ['81 characters', { name: 'n'.repeat(81) }],
    ['a number', { name: 7 }],
    ['null', { name: null }],
  ])('%s → 400 invalid_name', async (_, body) => {
    expectError(await P.post('/api/shortlists', body), 400, 'invalid_name');
    expectError(await P.patch(`/api/shortlists/${list}`, body), 400, 'invalid_name');
  });

  it('GET lists every list of the company, newest first', async () => {
    const newer = expectBody(await P.post('/api/shortlists', { name: 'Newer' }), 200, IdBody).id;
    const lists = expectBody(await P.get('/api/shortlists'), 200, z.array(ShortlistBody));
    const ids = lists.map((l) => l.id);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(list));
    expect(ids.indexOf(list)).toBeGreaterThanOrEqual(0);
  });

  it('POST person adds once; adding again changes nothing', async () => {
    expectBody(await P.post(`/api/shortlists/${list}/people/cand_0001`), 200, OkBody);
    expectBody(await P.post(`/api/shortlists/${list}/people/cand_0001`), 200, OkBody);
    const { rows } = await db().query('select count(*)::int as n from public.shortlist_people where shortlist_id = $1', [list]);
    expect(rows[0]?.n).toBe(1);
    expectBody(await P.post(`/api/shortlists/${list}/people/cand_0002`), 200, OkBody);
    const body = expectBody(await P.get(`/api/shortlists/${list}`), 200, ShortlistBody);
    expect(body.people_count).toBe(2);
    expect(body.people).toEqual([cardOf('cand_0002'), cardOf('cand_0001')]);
  });

  it('POST person → 404 for an unknown person or list', async () => {
    expectError(await P.post(`/api/shortlists/${list}/people/cand_9999`), 404, 'not_found');
    expectError(await P.post(`/api/shortlists/${list}/people/${'x'.repeat(65)}`), 404, 'not_found');
    expectError(await P.post(`/api/shortlists/${NIL}/people/cand_0001`), 404, 'not_found');
    expectError(await P.post('/api/shortlists/not-a-uuid/people/cand_0001'), 404, 'not_found');
  });

  it('a person id is sanitised like any other input (a NUL used to be a 500)', async () => {
    expectBody(await P.post(`/api/shortlists/${list}/people/cand_0003%00`), 200, OkBody);
    expect(expectBody(await P.get(`/api/shortlists/${list}`), 200, ShortlistBody).people.map((p) => p.id)).toContain('cand_0003');
    expectBody(await P.del(`/api/shortlists/${list}/people/cand_0003%00`), 200, OkBody);
    expect(expectBody(await P.get(`/api/shortlists/${list}`), 200, ShortlistBody).people.map((p) => p.id)).not.toContain('cand_0003');
    expect((await P.get('/api/people/cand_0001%00')).body).toMatchObject({ id: 'cand_0001' });
  });

  it('PATCH renames → { id, name }; 404 for an unknown list', async () => {
    const before = expectBody(await P.get(`/api/shortlists/${list}`), 200, ShortlistBody);
    expect(expectBody(await P.patch(`/api/shortlists/${list}`, { name: 'Renamed' }), 200, RenamedBody)).toEqual({ id: list, name: 'Renamed' });
    const after = expectBody(await P.get(`/api/shortlists/${list}`), 200, ShortlistBody);
    expect(after.name).toBe('Renamed');
    expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(before.updated_at));
    expectError(await P.patch(`/api/shortlists/${NIL}`, { name: 'x' }), 404, 'not_found');
    expectError(await P.patch('/api/shortlists/not-a-uuid', { name: 'x' }), 404, 'not_found');
  });

  it('DELETE person is idempotent; 404 for an unknown list', async () => {
    expectBody(await P.del(`/api/shortlists/${list}/people/cand_0001`), 200, OkBody);
    expectBody(await P.del(`/api/shortlists/${list}/people/cand_0001`), 200, OkBody);
    expectBody(await P.del(`/api/shortlists/${list}/people/cand_0042`), 200, OkBody);
    expect(expectBody(await P.get(`/api/shortlists/${list}`), 200, ShortlistBody).people).toEqual([cardOf('cand_0002')]);
    expectError(await P.del(`/api/shortlists/${NIL}/people/cand_0001`), 404, 'not_found');
  });

  it('DELETE removes the list and its people; after that every call on it is 404', async () => {
    expectBody(await P.del(`/api/shortlists/${list}`), 200, OkBody);
    const { rows } = await db().query('select count(*)::int as n from public.shortlist_people where shortlist_id = $1', [list]);
    expect(rows[0]?.n).toBe(0);
    expectError(await P.get(`/api/shortlists/${list}`), 404, 'not_found');
    expectError(await P.del(`/api/shortlists/${list}`), 404, 'not_found');
    expectError(await P.patch(`/api/shortlists/${list}`, { name: 'x' }), 404, 'not_found');
    expectError(await P.post(`/api/shortlists/${list}/people/cand_0001`), 404, 'not_found');
    expectError(await P.get('/api/shortlists/not-a-uuid'), 404, 'not_found');
  });
});

// ---- saved briefs ----

describe('saved briefs', () => {
  const FILTERS = { roles: ['Machine Learning Engineer'], seniority: ['staff'], cities: ['Seattle'] };
  let saved = '';

  it('POST saves { brief, filters } → { id }; GET lists it first', async () => {
    saved = expectBody(await P.post('/api/saved-briefs', { brief: 'staff ML engineers in Seattle', filters: FILTERS }), 200, IdBody).id;
    const [first] = expectBody(await P.get('/api/saved-briefs'), 200, z.array(SavedBody));
    expect(first).toEqual({ id: saved, brief: 'staff ML engineers in Seattle', filters: FILTERS, created_at: expect.any(String) });
  });

  it('accepts any JSON object as filters, sanitised', async () => {
    const id = expectBody(await P.post('/api/saved-briefs', { brief: 'nul\u0000 test', filters: { note: 'a\u0000b', n: [1, 2] } }), 200, IdBody).id;
    const row = expectBody(await P.get('/api/saved-briefs'), 200, z.array(SavedBody)).find((s) => s.id === id);
    expect(row).toMatchObject({ brief: 'nul test', filters: { note: 'ab', n: [1, 2] } });
  });

  it.each([
    ['no filters', { brief: 'x' }],
    ['filters that are an array', { brief: 'x', filters: [] }],
    ['filters that are null', { brief: 'x', filters: null }],
    ['filters that are a string', { brief: 'x', filters: 'roles' }],
    ['filters over 16 KB', { brief: 'x', filters: { pad: 'x'.repeat(17_000) } }],
    ['an empty brief', { brief: '', filters: {} }],
    ['1,001 characters', { brief: 'x'.repeat(1001), filters: {} }],
    ['no brief', { filters: {} }],
  ])('%s → 400', async (_, body) => {
    expectError(await P.post('/api/saved-briefs', body), 400);
  });

  it('DELETE → { ok: true }, then 404', async () => {
    expectBody(await P.del(`/api/saved-briefs/${saved}`), 200, OkBody);
    expect(expectBody(await P.get('/api/saved-briefs'), 200, z.array(SavedBody)).map((s) => s.id)).not.toContain(saved);
    expectError(await P.del(`/api/saved-briefs/${saved}`), 404, 'not_found');
    expectError(await P.del(`/api/saved-briefs/${NIL}`), 404, 'not_found');
    expectError(await P.del('/api/saved-briefs/not-a-uuid'), 404, 'not_found');
  });
});

// ---- cross-company ----

describe('another company’s ids are 404 and its data is unchanged', () => {
  let list = '';
  let saved = '';
  let search = '';
  let ownerBefore: Awaited<ReturnType<typeof companyRows>>;
  let attackerBefore: Awaited<ReturnType<typeof companyRows>>;

  beforeAll(async () => {
    list = expectBody(await O.post('/api/shortlists', { name: 'Owner list' }), 200, IdBody).id;
    expectBody(await O.post(`/api/shortlists/${list}/people/cand_0001`), 200, OkBody);
    saved = expectBody(await O.post('/api/saved-briefs', { brief: 'iOS developers', filters: SWIFT }), 200, IdBody).id;
    search = expectBody(await O.post('/api/search/refine', { brief: 'iOS developers', filters: SWIFT, source: 'edit' }), 200, SearchBody).search_id;
    ownerBefore = await companyRows(owner.companyId);
    attackerBefore = await companyRows(paid.companyId);
  });

  it('the lists leave them out', async () => {
    expect(expectBody(await P.get('/api/shortlists'), 200, z.array(ShortlistBody)).map((l) => l.id)).not.toContain(list);
    expect(expectBody(await P.get('/api/saved-briefs'), 200, z.array(SavedBody)).map((s) => s.id)).not.toContain(saved);
  });

  const attempts: [string, () => string, (id: string) => Promise<Res>][] = [
    ['GET /api/shortlists/{id}', () => list, (id) => P.get(`/api/shortlists/${id}`)],
    ['PATCH /api/shortlists/{id}', () => list, (id) => P.patch(`/api/shortlists/${id}`, { name: 'taken over' })],
    ['DELETE /api/shortlists/{id}', () => list, (id) => P.del(`/api/shortlists/${id}`)],
    ['POST /api/shortlists/{id}/people/{new person}', () => list, (id) => P.post(`/api/shortlists/${id}/people/cand_0002`)],
    ['POST /api/shortlists/{id}/people/{person already on it}', () => list, (id) => P.post(`/api/shortlists/${id}/people/cand_0001`)],
    ['DELETE /api/shortlists/{id}/people/{person}', () => list, (id) => P.del(`/api/shortlists/${id}/people/cand_0001`)],
    ['DELETE /api/saved-briefs/{id}', () => saved, (id) => P.del(`/api/saved-briefs/${id}`)],
    ['GET /api/search/{id}?page=1', () => search, (id) => P.get(`/api/search/${id}?page=1`)],
  ];

  it.each(attempts)('%s → 404, the same answer as for an id that doesn’t exist', async (_, target, attempt) => {
    const res = await attempt(target());
    expectError(res, 404, 'not_found');
    expect(res.body).toEqual((await attempt(NIL)).body);
  });

  it('nothing changed for either company', async () => {
    expect(await companyRows(owner.companyId)).toEqual(ownerBefore);
    expect(await companyRows(paid.companyId)).toEqual(attackerBefore);
  });

  it('the owner still sees all of it through the API', async () => {
    expect(expectBody(await O.get(`/api/shortlists/${list}`), 200, ShortlistBody)).toMatchObject({ name: 'Owner list', people_count: 1, people: [cardOf('cand_0001')] });
    expect(expectBody(await O.get('/api/saved-briefs'), 200, z.array(SavedBody)).map((s) => s.id)).toContain(saved);
    expect(expectBody(await O.get(`/api/search/${search}?page=1`), 200, PageBody).results).toHaveLength(20);
  });
});
