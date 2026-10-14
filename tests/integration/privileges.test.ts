// The exact privilege sets of the API roles (CLAUDE.md § Database rules). Any drift, a new grant or a
// missing one, fails here. If you change a grant, update this file in the same commit.
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, db } from './helpers/db';

afterAll(closeDb);

const API_ROLES = `(a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'service_role'))`;
const GRANTEE = `coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC')`;

async function grants(sql: string): Promise<string[]> {
  const { rows } = await db().query<{ line: string }>(sql);
  return rows.map((r) => r.line).sort();
}

describe('table and column privileges', () => {
  it('match the allowlist exactly, for every API role and PUBLIC', async () => {
    const actual = await grants(`
      select ${GRANTEE} || ': ' || a.privilege_type || ' on ' || n.nspname || '.' || c.relname as line
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and ${API_ROLES}
      union all
      select ${GRANTEE} || ': ' || a.privilege_type || ' (' || att.attname || ') on ' || n.nspname || '.' || c.relname
      from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(att.attacl) a
      where n.nspname in ('public', 'private') and att.attacl is not null and ${API_ROLES}`);

    expect(actual).toEqual(
      [
        // Candidates: read-only.
        'authenticated: SELECT on public.candidates',
        'authenticated: SELECT on public.candidate_experiences',
        'authenticated: SELECT on public.candidate_education',
        // Own company and own recruiter row: read-only.
        'authenticated: SELECT on public.companies',
        'authenticated: SELECT on public.recruiters',
        // Edited by the recruiter; inserts and updates are column-level.
        'authenticated: SELECT on public.shortlists',
        'authenticated: DELETE on public.shortlists',
        'authenticated: INSERT (name) on public.shortlists',
        'authenticated: UPDATE (name) on public.shortlists',
        'authenticated: SELECT on public.shortlist_people',
        'authenticated: DELETE on public.shortlist_people',
        'authenticated: INSERT (shortlist_id) on public.shortlist_people',
        'authenticated: INSERT (candidate_id) on public.shortlist_people',
        'authenticated: SELECT on public.saved_briefs',
        'authenticated: DELETE on public.saved_briefs',
        'authenticated: INSERT (brief) on public.saved_briefs',
        'authenticated: INSERT (filters) on public.saved_briefs',
        // Written only by SECURITY DEFINER functions.
        'authenticated: SELECT on public.searches',
        'authenticated: SELECT on public.search_results',
        'authenticated: SELECT on public.company_usage',
        'authenticated: SELECT on public.subscriptions',
        // processed_stripe_events: nothing for anyone. anon and service_role: nothing anywhere.
      ].sort(),
    );
  });
});

describe('function privileges', () => {
  it('match the EXECUTE allowlist exactly', async () => {
    const actual = await grants(`
      select ${GRANTEE} || ': EXECUTE ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as line
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname in ('public', 'private') and a.privilege_type = 'EXECUTE' and ${API_ROLES}`);

    expect(actual).toEqual(
      [
        // Called by RLS policies and column defaults, which run as the caller. `private` is not exposed
        // by PostgREST, so this is not an RPC (rls.test.ts checks that).
        'authenticated: EXECUTE private.current_company_id()',
        // The search and plan RPCs (quota migration).
        'authenticated: EXECUTE public.reserve_search(p_brief text, p_source text)',
        'authenticated: EXECUTE public.complete_search(p_search_id uuid, p_filters jsonb)',
        'authenticated: EXECUTE public.release_search(p_search_id uuid)',
        'authenticated: EXECUTE public.get_search_page(p_search_id uuid, p_page integer)',
        'authenticated: EXECUTE public.get_plan()',
        // Counts for "drop one filter" (count_relaxations migration). It is INVOKER, so the caller
        // also needs the matcher and the pure helpers it runs; `private` is still not an RPC schema.
        'authenticated: EXECUTE public.count_relaxations(p_search_id uuid, p_variants jsonb)',
        'authenticated: EXECUTE private.match_candidates(filters jsonb)',
        'authenticated: EXECUTE private.filter_list(obj jsonb, key text)',
        'authenticated: EXECUTE private.filter_int(obj jsonb, key text, lo integer, hi integer)',
        'authenticated: EXECUTE private.filter_bool(obj jsonb, key text)',
        'authenticated: EXECUTE private.filter_experience(obj jsonb)',
        'authenticated: EXECUTE private.mentions(haystack text, needle text)',
        // The Stripe webhook (billing migration): the route calls it with the secret key.
        'service_role: EXECUTE public.apply_stripe_event(p_event_id text, p_type text, p_created bigint, p_subscription_id text, p_status text, p_company text, p_customer text, p_current_period_end bigint)',
      ].sort(),
    );
  });

  it('grants every function to at most one API role', async () => {
    const { rows } = await db().query(`
      select p.oid::regprocedure::text as fn, array_agg(distinct ${GRANTEE}) as grantees
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname in ('public', 'private') and a.privilege_type = 'EXECUTE' and ${API_ROLES}
      group by p.oid having count(distinct a.grantee) > 1`);
    expect(rows).toEqual([]);
  });

  it("pins search_path = '' on every SECURITY DEFINER function", async () => {
    const { rows } = await db().query(`
      select p.oid::regprocedure::text as fn, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef
        and not coalesce('search_path=""' = any(p.proconfig), false)`);
    expect(rows).toEqual([]);
  });
});

describe('schema privileges', () => {
  it('opens private to authenticated (USAGE only) and to nobody else', async () => {
    const actual = await grants(`
      select ${GRANTEE} || ': ' || a.privilege_type as line
      from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      where n.nspname = 'private' and ${API_ROLES}`);
    expect(actual).toEqual(['authenticated: USAGE']);
  });
});

describe('policies', () => {
  it('apply to authenticated only, one per table, and none on processed_stripe_events', async () => {
    const { rows } = await db().query<{ line: string }>(
      `select tablename || ': ' || cmd || ' to ' || array_to_string(roles::text[], ',') as line
       from pg_policies where schemaname = 'public' order by tablename`,
    );
    expect(rows.map((r) => r.line)).toEqual([
      'candidate_education: SELECT to authenticated',
      'candidate_experiences: SELECT to authenticated',
      'candidates: SELECT to authenticated',
      'companies: SELECT to authenticated',
      'company_usage: SELECT to authenticated',
      'recruiters: SELECT to authenticated',
      'saved_briefs: ALL to authenticated',
      'search_results: SELECT to authenticated',
      'searches: SELECT to authenticated',
      'shortlist_people: ALL to authenticated',
      'shortlists: ALL to authenticated',
      'subscriptions: SELECT to authenticated',
    ]);
  });

  it("scope every company-owned table by the caller's company, in USING and WITH CHECK", async () => {
    const { rows } = await db().query<{ tablename: string; qual: string | null; with_check: string | null; cmd: string }>(
      `select tablename, qual, with_check, cmd from pg_policies
       where schemaname = 'public' and tablename in
         ('shortlists', 'shortlist_people', 'saved_briefs', 'searches', 'search_results', 'company_usage', 'subscriptions')`,
    );
    expect(rows).toHaveLength(7);
    const scoped = /^\(company_id = \( SELECT private\.current_company_id\(\) AS current_company_id\)\)$/;
    for (const r of rows) {
      expect(r.qual, r.tablename).toMatch(scoped);
      // A SELECT-only policy has no WITH CHECK; a writable one must repeat the scope.
      if (r.cmd !== 'SELECT') expect(r.with_check, r.tablename).toMatch(scoped);
    }
  });
});
