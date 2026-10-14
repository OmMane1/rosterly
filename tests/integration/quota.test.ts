// M5 acceptance: the free allowance is taken atomically, reservations can be given back, completed
// searches are frozen ranks that page for free, and nothing crosses companies. Everything goes
// through PostgREST with real recruiter tokens, on throwaway companies (helpers/tenant.ts).
import type { PostgrestError } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from './helpers/db';
import { publicClient, type Session } from './helpers/supabase';
import { createTenant, createUser, setSubscription, type Tenant } from './helpers/tenant';

const AUSTIN = { roles: ['Backend Engineer'], cities: ['Austin'], skills_all: ['Go', 'Kubernetes'] }; // 10 people
const SWIFT = { roles: ['Mobile Engineer'], skills_all: ['Swift'] }; // 249 people, 13 pages
const CARD_KEYS = [
  'avatar_url', 'current_company', 'current_company_logo_url', 'current_title', 'full_name', 'headline',
  'id', 'location', 'open_to_work', 'role', 'seniority', 'skills', 'years_experience',
];

type Page = { search_id: string; brief: string; filters: unknown; page: number; per_page: number; total: number; results: { id: string }[]; searches_remaining?: number | null };
type Result<T> = { data: T | null; error: PostgrestError | null };

const reserve = (s: Session, brief = 'quota test', source = 'brief') =>
  s.client.rpc('reserve_search', { p_brief: brief, p_source: source }) as unknown as Promise<Result<string>>;
const complete = (s: Session, id: string, filters: unknown) =>
  s.client.rpc('complete_search', { p_search_id: id, p_filters: filters }) as unknown as Promise<Result<Page>>;
const release = (s: Session, id: string) => s.client.rpc('release_search', { p_search_id: id }) as unknown as Promise<Result<null>>;
const page = (s: Session, id: string, p?: number) =>
  s.client.rpc('get_search_page', p === undefined ? { p_search_id: id } : { p_search_id: id, p_page: p }) as unknown as Promise<Result<Page>>;
const plan = async (s: Session) => (await s.client.rpc('get_plan')).data as unknown;

function ok<T>(res: Result<T>, what: string): T {
  if (res.error || res.data === null) throw new Error(`${what} failed: ${res.error?.code} ${res.error?.message}`);
  return res.data;
}

async function matchOrder(filters: unknown): Promise<string[]> {
  const { rows } = await db().query<{ candidate_id: string }>('select candidate_id from private.match_candidates($1::jsonb) order by rank', [JSON.stringify(filters)]);
  return rows.map((r) => r.candidate_id);
}

async function searchesOf(companyId: string) {
  const { rows } = await db().query<{ id: string; status: string }>('select id, status from public.searches where company_id = $1 order by created_at', [companyId]);
  return rows;
}

let free: Tenant; // spends its one free search, then goes paid and back
let other: Tenant; // a second company: isolation and the stale-reservation case
let done = ''; // free's completed AUSTIN search

beforeAll(async () => {
  free = await createTenant('quota');
  other = await createTenant('other');
}, 60_000);

afterAll(async () => {
  await free?.dispose();
  await other?.dispose();
  await closeDb();
});

describe('free plan: one search in total', () => {
  it('starts with 1 search left', async () => {
    expect(await plan(free)).toEqual({ plan: 'free', searches_remaining: 1 });
  });

  it('hands out exactly one of 50 concurrent reservations; the other 49 get P0402', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => reserve(free)));
    const winners = results.filter((r) => r.error === null);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === 'P0402')).toHaveLength(49);
    expect(await plan(free)).toEqual({ plan: 'free', searches_remaining: 0 });
    expect(await searchesOf(free.companyId)).toEqual([{ id: winners[0]?.data, status: 'pending' }]);
  });

  it('release gives the search back, once', async () => {
    const [pending] = await searchesOf(free.companyId);
    expect((await release(free, pending?.id ?? '')).error).toBeNull();
    expect(await plan(free)).toEqual({ plan: 'free', searches_remaining: 1 });
    expect(await searchesOf(free.companyId)).toEqual([]);
    expect((await release(free, pending?.id ?? '')).error?.code).toBe('42501');
    expect(await plan(free)).toEqual({ plan: 'free', searches_remaining: 1 });
  });

  it('rejects a bad brief or source without using the search', async () => {
    expect((await reserve(free, ' ')).error?.code).toBe('23514');
    expect((await reserve(free, 'x'.repeat(1001))).error?.code).toBe('23514');
    expect((await reserve(free, 'ok', 'bogus')).error?.code).toBe('23514');
    expect(await plan(free)).toEqual({ plan: 'free', searches_remaining: 1 });
  });

  it('complete stores ranked results and returns page 1 with the plan', async () => {
    done = ok(await reserve(free, 'backend engineers in Austin who know Go and Kubernetes'), 'reserve');
    const first = ok(await complete(free, done, AUSTIN), 'complete');
    expect(first).toMatchObject({ search_id: done, page: 1, per_page: 20, total: 10, filters: AUSTIN, searches_remaining: 0 });
    expect(first.results.map((c) => c.id)).toEqual(await matchOrder(AUSTIN));
    for (const card of first.results) expect(Object.keys(card).sort()).toEqual(CARD_KEYS);
    expect(await searchesOf(free.companyId)).toEqual([{ id: done, status: 'done' }]);
  });

  it('refuses to complete or release a search that is already done', async () => {
    expect((await complete(free, done, SWIFT)).error?.code).toBe('42501');
    expect((await release(free, done)).error?.code).toBe('42501');
    expect(await plan(free)).toEqual({ plan: 'free', searches_remaining: 0 });
    const { rows } = await db().query('select count(*)::int as n from public.search_results where search_id = $1', [done]);
    expect(rows[0]).toEqual({ n: 10 });
  });

  it('pages for free with no searches left; past the end is an empty page', async () => {
    const one = ok(await page(free, done), 'page 1');
    expect(one).toMatchObject({ search_id: done, brief: 'backend engineers in Austin who know Go and Kubernetes', page: 1, total: 10 });
    expect(one.results).toHaveLength(10);
    expect(ok(await page(free, done, 2), 'page 2').results).toEqual([]);
    expect(await plan(free)).toEqual({ plan: 'free', searches_remaining: 0 });
    expect((await reserve(free)).error?.code).toBe('P0402');
  });

  it('validates the page number and hides pending or unknown searches', async () => {
    for (const p of [0, -1, 10_001]) expect((await page(free, done, p)).error?.code, `page ${p}`).toBe('23514');
    expect((await page(free, '00000000-0000-0000-0000-000000000000')).error?.code).toBe('42501');
    const { rows } = await db().query<{ id: string }>(
      `insert into public.searches (company_id, recruiter_id, brief, source) values ($1, $2, 'pending', 'brief') returning id`,
      [free.companyId, free.userId],
    );
    const pending = rows[0]?.id ?? '';
    expect((await page(free, pending)).error?.code).toBe('42501');
    await db().query('delete from public.searches where id = $1', [pending]);
  });
});

describe('isolation between companies', () => {
  it("can't page, complete or release another company's search", async () => {
    const { rows } = await db().query<{ id: string }>(
      `insert into public.searches (company_id, recruiter_id, brief, source) values ($1, $2, 'pending', 'brief') returning id`,
      [free.companyId, free.userId],
    );
    const pending = rows[0]?.id ?? '';
    try {
      expect((await page(other, done)).error?.code).toBe('42501');
      expect((await complete(other, done, AUSTIN)).error?.code).toBe('42501');
      expect((await release(other, done)).error?.code).toBe('42501');
      expect((await complete(other, pending, AUSTIN)).error?.code).toBe('42501');
      expect((await release(other, pending)).error?.code).toBe('42501');
      expect(await searchesOf(free.companyId)).toEqual([
        { id: done, status: 'done' },
        { id: pending, status: 'pending' },
      ]);
      expect(await plan(other)).toEqual({ plan: 'free', searches_remaining: 1 });
    } finally {
      await db().query('delete from public.searches where id = $1', [pending]);
    }
  });

  it('a reservation pending for over 2 minutes is handed back by the next reserve', async () => {
    const stale = ok(await reserve(other), 'first reserve');
    expect((await reserve(other)).error?.code).toBe('P0402');
    await db().query("update public.searches set created_at = now() - interval '3 minutes' where id = $1", [stale]);
    const fresh = ok(await reserve(other), 'reserve after the stale one');
    expect(await searchesOf(other.companyId)).toEqual([{ id: fresh, status: 'pending' }]);
    expect(await plan(other)).toEqual({ plan: 'free', searches_remaining: 0 });
    expect((await complete(other, stale, AUSTIN)).error?.code).toBe('42501');
    expect((await release(other, fresh)).error).toBeNull();
    expect(await plan(other)).toEqual({ plan: 'free', searches_remaining: 1 });
  });
});

describe('paid plan', () => {
  it('has no limit while a subscription is active or trialing', async () => {
    await setSubscription(free.companyId, 'active');
    expect(await plan(free)).toEqual({ plan: 'paid', searches_remaining: null });
    for (let i = 0; i < 3; i++) {
      const id = ok(await reserve(free, `paid ${i}`, 'edit'), `paid reserve ${i}`);
      expect(ok(await complete(free, id, SWIFT), `paid complete ${i}`).searches_remaining).toBeNull();
    }
    await setSubscription(free.companyId, 'trialing');
    expect(await plan(free)).toEqual({ plan: 'paid', searches_remaining: null });
    await setSubscription(free.companyId, 'past_due');
    expect(await plan(free)).toEqual({ plan: 'free', searches_remaining: 0 });
    await setSubscription(free.companyId, 'active');
  });

  it('returns every result exactly once across all pages, in rank order', async () => {
    const id = ok(await reserve(free, 'mobile engineers who know Swift', 'saved'), 'reserve');
    const total = ok(await complete(free, id, SWIFT), 'complete').total;
    expect(total).toBe(249);
    const ids: string[] = [];
    for (let p = 1; p <= 14; p++) {
      const { results } = ok(await page(free, id, p), `page ${p}`);
      expect(results.length, `page ${p}`).toBe(p <= 12 ? 20 : p === 13 ? 9 : 0);
      ids.push(...results.map((c) => c.id));
    }
    expect(new Set(ids).size).toBe(249);
    expect(ids).toEqual(await matchOrder(SWIFT));
  });

  it('after cancelling, a company that searched has 0 left (1 search in total)', async () => {
    await setSubscription(free.companyId, 'canceled');
    expect(await plan(free)).toEqual({ plan: 'free', searches_remaining: 0 });
    expect((await reserve(free)).error?.code).toBe('P0402');
    expect(ok(await page(free, done), 'page after cancelling').results).toHaveLength(10);
  });
});

describe('callers that are not recruiters', () => {
  it('a signed-in non-recruiter is refused by every RPC', async () => {
    const outsider = await createUser('outsider');
    try {
      expect((await reserve(outsider)).error?.code).toBe('42501');
      expect((await outsider.client.rpc('get_plan')).error?.code).toBe('42501');
      expect((await page(outsider, done)).error?.code).toBe('42501');
      expect((await complete(outsider, done, AUSTIN)).error?.code).toBe('42501');
      expect((await release(outsider, done)).error?.code).toBe('42501');
    } finally {
      await outsider.dispose();
    }
  });

  it('anon can execute none of them', async () => {
    const anon = publicClient();
    const calls = {
      reserve: anon.rpc('reserve_search', { p_brief: 'x', p_source: 'brief' }),
      complete: anon.rpc('complete_search', { p_search_id: done, p_filters: AUSTIN }),
      release: anon.rpc('release_search', { p_search_id: done }),
      page: anon.rpc('get_search_page', { p_search_id: done }),
      plan: anon.rpc('get_plan'),
    };
    for (const [name, call] of Object.entries(calls)) expect((await call).error?.code, name).toBe('42501');
  });
});

describe('per-recruiter pace: 20 searches a minute, 100 an hour', () => {
  let pace: Tenant; // paid, so only the pace limits it
  let colleague: Awaited<ReturnType<typeof createUser>>; // a second recruiter at the same company

  const used = async (companyId: string) =>
    (await db().query<{ n: number }>('select searches_used as n from public.company_usage where company_id = $1', [companyId])).rows[0]?.n;
  // Done searches by `userId`, `minutesAgo` old: they count towards the pace but are never handed back.
  const pastSearches = (userId: string, n: number, minutesAgo: number) =>
    db().query(
      `insert into public.searches (company_id, recruiter_id, brief, source, status, filters, total, created_at, completed_at)
       select $1, $2, 'pace history', 'edit', 'done', '{}', 0, now() - make_interval(mins => $4), now() from generate_series(1, $3)`,
      [pace.companyId, userId, n, minutesAgo],
    );

  beforeAll(async () => {
    pace = await createTenant('pace');
    await setSubscription(pace.companyId, 'active');
    colleague = await createUser('pace-colleague');
    await db().query('insert into public.recruiters (user_id, company_id) values ($1, $2)', [colleague.userId, pace.companyId]);
  }, 60_000);

  afterAll(async () => {
    await pace?.dispose(); // the company's searches and recruiter rows go with it
    await colleague?.dispose();
  });

  it('25 concurrent reservations: exactly 20 go through, and the other 5 get P0429 and use nothing', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => reserve(pace, `pace ${i}`, 'edit')));
    expect(results.filter((r) => r.error === null)).toHaveLength(20);
    expect(results.filter((r) => r.error?.code === 'P0429')).toHaveLength(5);
    expect(await used(pace.companyId)).toBe(20);
    expect(await searchesOf(pace.companyId)).toHaveLength(20);
  });

  it('a colleague at the same company keeps their own allowance', async () => {
    expect((await reserve(colleague)).error).toBeNull();
    expect((await reserve(pace)).error?.code).toBe('P0429');
  });

  it('the minute window passes; 100 in the last hour still refuse, and 61 minutes ago no longer counts', async () => {
    await db().query("update public.searches set status = 'done', filters = '{}', total = 0, completed_at = now(), created_at = now() - interval '5 minutes' where company_id = $1", [pace.companyId]);
    const before = await used(pace.companyId);
    expect((await reserve(pace)).error).toBeNull(); // 21 in the hour, none in the last minute

    await pastSearches(pace.userId, 79, 10); // 100 in the hour
    expect((await reserve(pace)).error?.code).toBe('P0429');

    await db().query("update public.searches set created_at = now() - interval '61 minutes' where recruiter_id = $1 and brief = 'pace history'", [pace.userId]);
    expect((await reserve(pace)).error).toBeNull();
    expect(await used(pace.companyId)).toBe((before ?? 0) + 2);
  });

  it('on the free plan the 402 comes first', async () => {
    await setSubscription(pace.companyId, 'canceled');
    expect((await reserve(pace)).error?.code).toBe('P0402');
  });
});
