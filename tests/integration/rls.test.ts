// M3 acceptance: a recruiter's own token, used directly against Supabase (PostgREST over Kong), can
// neither read nor change the other company's rows, nor its own read-only rows. anon reads nothing.
//
// Fixtures are made through glenfold's own token where the grants allow it (so the happy path is
// exercised too) and through pg where only SECURITY DEFINER functions will write (searches,
// subscriptions). afterAll deletes exactly those rows.
import { randomUUID } from 'node:crypto';
import type { PostgrestError } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS } from '@/lib/shared/demo-accounts';
import { closeDb, db } from './helpers/db';
import { adminClient, publicClient, publishableKey, signIn, supabaseUrl, type Session } from './helpers/supabase';

const DENIED = '42501';
const FOREIGN_KEY = '23503';
const TAG = `rls-${randomUUID().slice(0, 8)}`;

const ALL_TABLES = [
  'candidates',
  'candidate_experiences',
  'candidate_education',
  'companies',
  'recruiters',
  'shortlists',
  'shortlist_people',
  'saved_briefs',
  'searches',
  'search_results',
  'company_usage',
  'subscriptions',
  'processed_stripe_events',
] as const;
const COMPANY_TABLES = ['shortlists', 'shortlist_people', 'saved_briefs', 'searches', 'search_results', 'company_usage', 'subscriptions'] as const;

let asterwell: Session;
let glenfold: Session;
let outsider: Session;
const company = { asterwell: '', glenfold: '' };
const fx = { asterwellList: '', glenfoldList: '', glenfoldBrief: '', asterwellSearch: '', glenfoldSearch: '' };

async function one<T>(sql: string, values: unknown[]): Promise<T> {
  const { rows } = await db().query<T & object>(sql, values);
  if (!rows[0]) throw new Error(`no row from: ${sql}`);
  return rows[0];
}

function idOf(res: { data: { id: string } | null; error: PostgrestError | null }, what: string): string {
  if (res.error || !res.data) throw new Error(`creating ${what} failed: ${res.error?.message}`);
  return res.data.id;
}

async function createSearch(companyId: string, recruiterId: string): Promise<string> {
  const { id } = await one<{ id: string }>(
    `insert into public.searches (company_id, recruiter_id, brief, source, status, filters, total, completed_at)
     values ($1, $2, $3, 'brief', 'done', '{}', 1, now()) returning id`,
    [companyId, recruiterId, TAG],
  );
  await db().query(`insert into public.search_results (search_id, rank, company_id, candidate_id) values ($1, 1, $2, 'cand_0001')`, [id, companyId]);
  return id;
}

/** Everything of glenfold's an attack could change, read as the table owner. */
async function glenfoldState() {
  return one(
    `select
       (select row_to_json(s) from public.shortlists s where s.id = $1) as shortlist,
       (select json_agg(p order by p.candidate_id) from public.shortlist_people p where p.shortlist_id = $1) as people,
       (select row_to_json(b) from public.saved_briefs b where b.id = $2) as brief,
       (select row_to_json(x) from public.searches x where x.id = $3) as search,
       (select json_agg(r order by r.rank) from public.search_results r where r.search_id = $3) as results,
       (select json_agg(t order by t.stripe_subscription_id) from public.subscriptions t where t.company_id = $4) as subscriptions,
       (select row_to_json(u) from public.company_usage u where u.company_id = $4) as usage,
       (select json_agg(r order by r.user_id) from public.recruiters r where r.company_id = $4) as recruiters,
       (select row_to_json(c) from public.companies c where c.id = $4) as company,
       (select count(*) from public.shortlists where company_id = $4)::int as shortlists,
       (select count(*) from public.saved_briefs where company_id = $4)::int as saved_briefs`,
    [fx.glenfoldList, fx.glenfoldBrief, fx.glenfoldSearch, company.glenfold],
  );
}

/** Runs each attempt and returns the PostgREST error code it got (undefined = it succeeded). */
async function codes(attempts: Record<string, PromiseLike<{ error: PostgrestError | null }>>): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [label, attempt] of Object.entries(attempts)) out[label] = (await attempt).error?.code;
  return out;
}

const every = (labels: Record<string, unknown>, code: string) => Object.fromEntries(Object.keys(labels).map((k) => [k, code]));

let before: Awaited<ReturnType<typeof glenfoldState>>;

beforeAll(async () => {
  const [asterwellAccount, glenfoldAccount] = DEMO_ACCOUNTS;
  asterwell = await signIn(asterwellAccount.email);
  glenfold = await signIn(glenfoldAccount.email);
  company.asterwell = (await one<{ id: string }>('select id from public.companies where slug = $1', [asterwellAccount.slug])).id;
  company.glenfold = (await one<{ id: string }>('select id from public.companies where slug = $1', [glenfoldAccount.slug])).id;

  fx.asterwellList = idOf(await asterwell.client.from('shortlists').insert({ name: `${TAG} asterwell` }).select('id').single(), 'asterwell shortlist');
  fx.glenfoldList = idOf(await glenfold.client.from('shortlists').insert({ name: `${TAG} glenfold` }).select('id').single(), 'glenfold shortlist');
  const added = await glenfold.client.from('shortlist_people').insert({ shortlist_id: fx.glenfoldList, candidate_id: 'cand_0001' });
  if (added.error) throw new Error(`adding a person failed: ${added.error.message}`);
  await asterwell.client.from('shortlist_people').insert({ shortlist_id: fx.asterwellList, candidate_id: 'cand_0001' });
  fx.glenfoldBrief = idOf(await glenfold.client.from('saved_briefs').insert({ brief: TAG, filters: {} }).select('id').single(), 'glenfold saved brief');
  await asterwell.client.from('saved_briefs').insert({ brief: TAG, filters: {} });

  fx.asterwellSearch = await createSearch(company.asterwell, asterwell.userId);
  fx.glenfoldSearch = await createSearch(company.glenfold, glenfold.userId);
  for (const [slug, id] of Object.entries(company)) {
    await db().query(
      `insert into public.subscriptions (stripe_subscription_id, company_id, status, last_event_id, last_event_created, last_event_type)
       values ($1, $2, 'canceled', $1, 0, 'test')`,
      [`sub_${TAG}_${slug}`, id],
    );
  }

  const email = `${TAG}@outsider.test`;
  const created = await adminClient().auth.admin.createUser({ email, password: `${TAG}-password`, email_confirm: true });
  if (created.error) throw new Error(`creating the outsider failed: ${created.error.message}`);
  outsider = await signIn(email, `${TAG}-password`);

  before = await glenfoldState();
}, 60_000);

afterAll(async () => {
  await db().query('delete from public.shortlists where id = any($1)', [[fx.asterwellList, fx.glenfoldList].filter(Boolean)]);
  await db().query('delete from public.saved_briefs where brief = $1', [TAG]);
  await db().query('delete from public.searches where brief = $1', [TAG]);
  await db().query('delete from public.subscriptions where stripe_subscription_id like $1', [`sub_${TAG}_%`]);
  if (outsider) await adminClient().auth.admin.deleteUser(outsider.userId);
  await closeDb();
});

describe("a recruiter's token against the other company (PostgREST)", () => {
  it('sees its own rows, and only its own, in every company table', async () => {
    for (const table of COMPANY_TABLES) {
      const { data, error } = await asterwell.client.from(table).select('company_id');
      expect(error, table).toBeNull();
      expect(data?.length, table).toBeGreaterThan(0);
      expect(new Set(data?.map((r) => r.company_id)), table).toEqual(new Set([company.asterwell]));
    }
    expect((await asterwell.client.from('companies').select('id')).data).toEqual([{ id: company.asterwell }]);
    expect((await asterwell.client.from('recruiters').select('user_id, company_id')).data).toEqual([{ user_id: asterwell.userId, company_id: company.asterwell }]);
  });

  it("can't find the other company's rows even by id", async () => {
    const lookups = {
      shortlist: asterwell.client.from('shortlists').select('id').eq('id', fx.glenfoldList),
      people: asterwell.client.from('shortlist_people').select('candidate_id').eq('shortlist_id', fx.glenfoldList),
      savedBrief: asterwell.client.from('saved_briefs').select('id').eq('id', fx.glenfoldBrief),
      search: asterwell.client.from('searches').select('id').eq('id', fx.glenfoldSearch),
      results: asterwell.client.from('search_results').select('rank').eq('search_id', fx.glenfoldSearch),
      usage: asterwell.client.from('company_usage').select('company_id').eq('company_id', company.glenfold),
      subscription: asterwell.client.from('subscriptions').select('company_id').eq('company_id', company.glenfold),
      company: asterwell.client.from('companies').select('id').eq('id', company.glenfold),
      recruiter: asterwell.client.from('recruiters').select('user_id').eq('user_id', glenfold.userId),
    };
    for (const [label, lookup] of Object.entries(lookups)) {
      const { data, error } = await lookup;
      expect({ label, error, data }).toEqual({ label, error: null, data: [] });
    }
  });

  it("can't insert into the other company", async () => {
    expect(
      await codes({
        shortlistForGlenfold: asterwell.client.from('shortlists').insert({ name: TAG, company_id: company.glenfold }),
        personOnGlenfoldList: asterwell.client.from('shortlist_people').insert({ shortlist_id: fx.glenfoldList, candidate_id: 'cand_0002' }),
        personWithCompanyId: asterwell.client.from('shortlist_people').insert({ shortlist_id: fx.glenfoldList, candidate_id: 'cand_0002', company_id: company.glenfold }),
        savedBriefForGlenfold: asterwell.client.from('saved_briefs').insert({ brief: TAG, filters: {}, company_id: company.glenfold }),
      }),
    ).toEqual({ shortlistForGlenfold: DENIED, personOnGlenfoldList: FOREIGN_KEY, personWithCompanyId: DENIED, savedBriefForGlenfold: DENIED });
    expect(await glenfoldState()).toEqual(before);
  });

  it("can't update the other company's rows, or move its own rows to it", async () => {
    const renamed = await asterwell.client.from('shortlists').update({ name: 'pwned' }).eq('id', fx.glenfoldList).select('id');
    expect({ error: renamed.error, data: renamed.data }).toEqual({ error: null, data: [] });
    expect(
      await codes({
        moveList: asterwell.client.from('shortlists').update({ company_id: company.glenfold }).eq('id', fx.asterwellList),
        moveSavedBrief: asterwell.client.from('saved_briefs').update({ company_id: company.glenfold }).eq('brief', TAG),
        editSavedBrief: asterwell.client.from('saved_briefs').update({ brief: 'pwned' }).eq('id', fx.glenfoldBrief),
        movePerson: asterwell.client.from('shortlist_people').update({ shortlist_id: fx.glenfoldList }).eq('shortlist_id', fx.asterwellList),
      }),
    ).toEqual({ moveList: DENIED, moveSavedBrief: DENIED, editSavedBrief: DENIED, movePerson: DENIED });
    expect(await glenfoldState()).toEqual(before);
  });

  it("can't delete the other company's rows", async () => {
    const deletes = {
      people: asterwell.client.from('shortlist_people').delete().eq('shortlist_id', fx.glenfoldList).select('candidate_id'),
      shortlist: asterwell.client.from('shortlists').delete().eq('id', fx.glenfoldList).select('id'),
      savedBrief: asterwell.client.from('saved_briefs').delete().eq('id', fx.glenfoldBrief).select('id'),
    };
    for (const [label, attempt] of Object.entries(deletes)) {
      const { data, error } = await attempt;
      expect({ label, error, data }).toEqual({ label, error: null, data: [] });
    }
    expect(await glenfoldState()).toEqual(before);
  });
});

describe("a recruiter's token on its own company's lists (the paths M7 relies on)", () => {
  it('creates, renames, fills idempotently, empties and deletes its own shortlist', async () => {
    const id = idOf(await asterwell.client.from('shortlists').insert({ name: `${TAG} temp` }).select('id').single(), 'temp list');
    const renamed = await asterwell.client.from('shortlists').update({ name: `${TAG} renamed` }).eq('id', id).select('name, created_at, updated_at').single();
    expect(renamed.error).toBeNull();
    expect(renamed.data?.name).toBe(`${TAG} renamed`);
    // The updated_at trigger runs for the caller without any EXECUTE grant on it.
    expect(Date.parse(renamed.data?.updated_at ?? '')).toBeGreaterThan(Date.parse(renamed.data?.created_at ?? ''));

    for (let i = 0; i < 2; i++) {
      const added = await asterwell.client
        .from('shortlist_people')
        .upsert({ shortlist_id: id, candidate_id: 'cand_0002' }, { onConflict: 'shortlist_id,candidate_id', ignoreDuplicates: true });
      expect(added.error).toBeNull();
    }
    const removed = await asterwell.client.from('shortlist_people').delete().eq('shortlist_id', id).select('candidate_id');
    expect(removed.data).toEqual([{ candidate_id: 'cand_0002' }]);
    const deleted = await asterwell.client.from('shortlists').delete().eq('id', id).select('id');
    expect(deleted.data).toEqual([{ id }]);
  });
});

describe("a recruiter's token against its own read-only rows", () => {
  it("can't change its recruiter row, company, usage or subscriptions", async () => {
    const attempts = {
      moveRecruiter: asterwell.client.from('recruiters').update({ company_id: company.glenfold }).eq('user_id', asterwell.userId),
      addRecruiter: asterwell.client.from('recruiters').insert({ user_id: asterwell.userId, company_id: company.glenfold }),
      dropRecruiter: asterwell.client.from('recruiters').delete().eq('user_id', asterwell.userId),
      renameCompany: asterwell.client.from('companies').update({ name: 'pwned' }).eq('id', company.asterwell),
      resetUsage: asterwell.client.from('company_usage').update({ searches_used: 0 }).eq('company_id', company.asterwell),
      addUsage: asterwell.client.from('company_usage').insert({ company_id: company.asterwell, searches_used: 0 }),
      dropUsage: asterwell.client.from('company_usage').delete().eq('company_id', company.asterwell),
      selfUpgrade: asterwell.client.from('subscriptions').update({ status: 'active' }).eq('company_id', company.asterwell),
      addSubscription: asterwell.client
        .from('subscriptions')
        .insert({ stripe_subscription_id: `sub_${TAG}_x`, company_id: company.asterwell, status: 'active', last_event_id: 'e', last_event_created: 9e9, last_event_type: 't' }),
      cancelGlenfold: asterwell.client.from('subscriptions').delete().eq('company_id', company.glenfold),
    };
    expect(await codes(attempts)).toEqual(every(attempts, DENIED));
    expect(await glenfoldState()).toEqual(before);
  });

  it("can't write searches, results, candidates or processed events", async () => {
    const attempts = {
      insertSearch: asterwell.client.from('searches').insert({ company_id: company.asterwell, recruiter_id: asterwell.userId, brief: TAG, source: 'brief' }),
      finishSearch: asterwell.client.from('searches').update({ total: 0 }).eq('id', fx.asterwellSearch),
      dropSearch: asterwell.client.from('searches').delete().eq('id', fx.asterwellSearch),
      insertResult: asterwell.client.from('search_results').insert({ search_id: fx.asterwellSearch, rank: 2, company_id: company.asterwell, candidate_id: 'cand_0002' }),
      reorderResults: asterwell.client.from('search_results').update({ rank: 9 }).eq('search_id', fx.asterwellSearch),
      editCandidate: asterwell.client.from('candidates').update({ headline: 'pwned' }).eq('id', 'cand_0001'),
      dropCandidate: asterwell.client.from('candidates').delete().eq('id', 'cand_0001'),
      addExperience: asterwell.client.from('candidate_experiences').insert({ candidate_id: 'cand_0001', position: 9 }),
      editEducation: asterwell.client.from('candidate_education').update({ school: 'pwned' }).eq('candidate_id', 'cand_0001'),
      readEvents: asterwell.client.from('processed_stripe_events').select('event_id'),
      forgeEvent: asterwell.client.from('processed_stripe_events').insert({ event_id: TAG, type: 't', created: 0, outcome: 'o' }),
    };
    expect(await codes(attempts)).toEqual(every(attempts, DENIED));
    const { rows } = await db().query(`select 1 from public.searches where id = $1 and total = 1`, [fx.asterwellSearch]);
    expect(rows).toHaveLength(1);
  });

  it('can read every candidate, with experiences and education', async () => {
    for (const table of ['candidates', 'candidate_education'] as const) {
      const { count, error } = await asterwell.client.from(table).select('*', { count: 'exact', head: true });
      expect({ table, error, count }).toEqual({ table, error: null, count: 5000 });
    }
    const { count } = await asterwell.client.from('candidate_experiences').select('*', { count: 'exact', head: true });
    expect(count).toBe(14344);
  });

  it("can't reach private helpers, billing or GraphQL", async () => {
    const billing = await asterwell.client.rpc('apply_stripe_event', {});
    expect(['PGRST202', DENIED]).toContain(billing.error?.code);
    const helper = await asterwell.client.schema('private').rpc('current_company_id');
    expect(helper.error?.code).toBe('PGRST106');
    const graphql = await fetch(`${supabaseUrl()}/graphql/v1`, {
      method: 'POST',
      headers: { apikey: publishableKey(), Authorization: `Bearer ${asterwell.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    expect(graphql.status).not.toBe(200);
  });
});

describe('anon (publishable key, no sign-in)', () => {
  it('is denied every table', async () => {
    const anon = publicClient();
    const attempts = Object.fromEntries(ALL_TABLES.map((t) => [t, anon.from(t).select('*').limit(1)]));
    expect(await codes(attempts)).toEqual(every(attempts, DENIED));
  });

  it('sees no table in the OpenAPI description', async () => {
    const res = await fetch(`${supabaseUrl()}/rest/v1/`, { headers: { apikey: publishableKey() } });
    const spec = (await res.json()) as { paths?: Record<string, unknown> };
    expect(Object.keys(spec.paths ?? {})).toEqual(['/']);
  });

  it('cannot sign up or sign in anonymously', async () => {
    const signUp = await publicClient().auth.signUp({ email: `${TAG}@signup.test`, password: 'a-long-password' });
    expect(signUp.error?.code).toBe('signup_disabled');
    const anonymous = await publicClient().auth.signInAnonymously();
    expect(anonymous.error).not.toBeNull();
    const { rows } = await db().query('select 1 from auth.users where email = $1', [`${TAG}@signup.test`]);
    expect(rows).toEqual([]);
  });
});

describe('a signed-in user who is not a recruiter', () => {
  it('reads no candidates and no company data, and creates nothing', async () => {
    for (const table of ALL_TABLES.filter((t) => t !== 'processed_stripe_events')) {
      const { data, error } = await outsider.client.from(table).select('*').limit(1);
      expect({ table, error, data }).toEqual({ table, error: null, data: [] });
    }
    const created = await outsider.client.from('shortlists').insert({ name: TAG });
    expect(created.error).not.toBeNull();
    const { rows } = await db().query('select 1 from public.shortlists where created_by = $1', [outsider.userId]);
    expect(rows).toEqual([]);
  });
});
