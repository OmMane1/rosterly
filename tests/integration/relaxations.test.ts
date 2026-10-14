// count_relaxations (DECISIONS.md "Suggesting a broader search when nothing matches"): counts for a
// stored search's own filters with parts removed, read under RLS, and never a search used. Everything
// goes through PostgREST with real recruiter tokens, on throwaway companies.
import type { PostgrestError } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from './helpers/db';
import { publicClient, type Session } from './helpers/supabase';
import { createTenant, createUser, setSubscription, type Tenant } from './helpers/tenant';

const NOWHERE = { roles: ['Recruiter'], cities: ['Denver'], skills_all: ['CUDA'] }; // 0 people
const ONE_STEP = [
  { cities: ['Denver'], skills_all: ['CUDA'] }, // 7
  { roles: ['Recruiter'], skills_all: ['CUDA'] }, // 0
  { roles: ['Recruiter'], cities: ['Denver'] }, // 26
];

type Result<T> = { data: T | null; error: PostgrestError | null };

const counts = (s: { client: Session['client'] }, id: string, variants: unknown) =>
  s.client.rpc('count_relaxations', { p_search_id: id, p_variants: variants }) as unknown as Promise<Result<number[]>>;

function ok<T>(res: Result<T>, what: string): T {
  if (res.error || res.data === null) throw new Error(`${what} failed: ${res.error?.code} ${res.error?.message}`);
  return res.data;
}

async function reserve(s: Session): Promise<string> {
  return ok((await s.client.rpc('reserve_search', { p_brief: 'relaxations test', p_source: 'edit' })) as Result<string>, 'reserve');
}

async function searchOf(s: Session, filters: unknown): Promise<string> {
  const id = await reserve(s);
  ok((await s.client.rpc('complete_search', { p_search_id: id, p_filters: filters })) as Result<unknown>, 'complete');
  return id;
}

const matchCount = async (filters: unknown) =>
  (await db().query<{ n: number }>('select count(*)::int as n from private.match_candidates($1::jsonb)', [JSON.stringify(filters)])).rows[0]?.n;
const used = async (companyId: string) =>
  (await db().query<{ n: number }>('select searches_used as n from public.company_usage where company_id = $1', [companyId])).rows[0]?.n;

let mine: Tenant;
let theirs: Tenant;
let empty = ''; // mine's NOWHERE search

beforeAll(async () => {
  [mine, theirs] = await Promise.all([createTenant('relax'), createTenant('relax-other')]);
  await Promise.all([setSubscription(mine.companyId, 'active'), setSubscription(theirs.companyId, 'active')]);
  empty = await searchOf(mine, NOWHERE);
}, 60_000);

afterAll(async () => {
  await mine?.dispose();
  await theirs?.dispose();
  await closeDb();
});

describe('count_relaxations', () => {
  it('counts each variant exactly like match_candidates, in order, and uses no search', async () => {
    expect(await matchCount(NOWHERE)).toBe(0);
    const before = await used(mine.companyId);
    const expected = await Promise.all(ONE_STEP.map(matchCount));
    expect(expected).toEqual([7, 0, 26]);
    expect(ok(await counts(mine, empty, ONE_STEP), 'counts')).toEqual(expected);
    expect(ok(await counts(mine, empty, []), 'no variants')).toEqual([]);
    expect(await used(mine.companyId)).toBe(before);
  });

  it('counts a variant with nothing left to search on as 0 (match_candidates never returns everyone)', async () => {
    expect(ok(await counts(mine, empty, [{}]), 'empty variant')).toEqual([0]);
  });

  it.each([
    ['a value the search did not have', { roles: ['Recruiter', 'Product Manager'] }],
    ['a field the search did not have', { roles: ['Recruiter'], years_min: 3 }],
    ['a different skill', { skills_all: ['Go'] }],
    ['a string instead of filters', 'Denver'],
  ])('refuses a variant with %s (23514)', async (_, variant) => {
    expect((await counts(mine, empty, [ONE_STEP[0], variant])).error?.code).toBe('23514');
  });

  it('refuses variants that are not an array, or more than 25 of them (23514)', async () => {
    expect((await counts(mine, empty, { cities: ['Denver'] })).error?.code).toBe('23514');
    expect((await counts(mine, empty, Array.from({ length: 26 }, () => ONE_STEP[0]))).error?.code).toBe('23514');
  });

  it("another company's search, a pending one and an unknown id all look the same (42501)", async () => {
    expect((await counts(theirs, empty, ONE_STEP)).error?.code).toBe('42501');
    const pending = await reserve(mine);
    try {
      expect((await counts(mine, pending, [])).error?.code).toBe('42501');
    } finally {
      await mine.client.rpc('release_search', { p_search_id: pending });
    }
    expect((await counts(mine, '00000000-0000-4000-8000-000000000000', [])).error?.code).toBe('42501');
  });

  it('a signed-in non-recruiter and anon are refused', async () => {
    const outsider = await createUser('relax-outsider');
    try {
      expect((await counts(outsider, empty, [])).error?.code).toBe('42501');
    } finally {
      await outsider.dispose();
    }
    expect((await counts({ client: publicClient() }, empty, [])).error?.code).toBe('42501');
  });
});
