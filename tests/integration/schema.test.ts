import { afterAll, describe, expect, it } from 'vitest';
import { COMPANY_TYPES, SENIORITIES } from '@/lib/shared/vocabulary.generated';
import { actAs, closeDb, createCandidate, createCompany, createRecruiter, db, inRollback, sqlState, type Tx } from './helpers/db';

const CHECK = '23514';
const NOT_NULL = '23502';
const FOREIGN_KEY = '23503';
const UNIQUE = '23505';

const TABLES = [
  'candidate_education',
  'candidate_experiences',
  'candidates',
  'companies',
  'company_usage',
  'processed_stripe_events',
  'recruiters',
  'saved_briefs',
  'search_results',
  'searches',
  'shortlist_people',
  'shortlists',
  'subscriptions',
];

afterAll(closeDb);

describe('baseline', () => {
  it('has exactly the planned tables, each with RLS enabled', async () => {
    const { rows } = await db().query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') order by c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual(TABLES);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it('gives new objects no default privileges for the API roles or PUBLIC', async () => {
    const { rows } = await db().query(
      `select coalesce(n.nspname, '<global>') as schema, d.defaclobjtype as type, a.privilege_type,
              coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC') as grantee
       from pg_default_acl d
       left join pg_namespace n on n.oid = d.defaclnamespace
       cross join lateral aclexplode(d.defaclacl) a
       where pg_get_userbyid(d.defaclrole) = 'postgres'
         and coalesce(n.nspname, '') in ('', 'public', 'private')
         and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'service_role'))`,
    );
    expect(rows).toEqual([]);
  });

  it('never grants TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on a table to an API role', async () => {
    const { rows } = await db().query(
      `select c.relname, a.privilege_type, coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC') as grantee
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
       where n.nspname = 'public' and c.relkind = 'r'
         and a.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
         and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'service_role'))`,
    );
    expect(rows).toEqual([]);
  });

  it('lets neither PUBLIC nor anon execute any function in public or private', async () => {
    const { rows } = await db().query(
      `select n.nspname, p.proname, coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC') as grantee
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where n.nspname in ('public', 'private')
         and (a.grantee = 0 or pg_get_userbyid(a.grantee) = 'anon')`,
    );
    expect(rows).toEqual([]);
  });

  it('keeps the private schema closed to PUBLIC and anon', async () => {
    const { rows } = await db().query<{ public_usage: boolean; anon_usage: boolean }>(
      `select has_schema_privilege('public', 'private', 'usage') as public_usage,
              has_schema_privilege('anon', 'private', 'usage') as anon_usage`,
    );
    expect(rows[0]).toEqual({ public_usage: false, anon_usage: false });
  });
});

describe('candidates', () => {
  it('rejects a seniority outside the four the data uses, and accepts each of those', async () => {
    await inRollback(async (c) => {
      const id = await createCandidate(c);
      expect(await sqlState(c, 'update public.candidates set seniority = $2 where id = $1', [id, 'lead'])).toBe(CHECK);
      expect(await sqlState(c, 'update public.candidates set seniority = $2 where id = $1', [id, 'Senior'])).toBe(CHECK);
      for (const s of SENIORITIES) {
        expect(await sqlState(c, 'update public.candidates set seniority = $2 where id = $1', [id, s])).toBeNull();
      }
    });
  });

  it('rejects empty skills or a null skill', async () => {
    await inRollback(async (c) => {
      const id = await createCandidate(c);
      expect(await sqlState(c, `update public.candidates set skills = '{}' where id = $1`, [id])).toBe(CHECK);
      expect(await sqlState(c, `update public.candidates set skills = '{Go,NULL}' where id = $1`, [id])).toBe(CHECK);
    });
  });

  it('checks experiences: known company type, sane years, one current job', async () => {
    await inRollback(async (c) => {
      const id = await createCandidate(c);
      const insert = (position: number, type: string, start: number, end: number | null) =>
        sqlState(
          c,
          `insert into public.candidate_experiences
             (candidate_id, position, title, company, company_type, company_logo_url, start_year, end_year, description)
           values ($1, $2, 'Engineer', 'Fizzbit', $3, 'https://example.test/l.svg', $4, $5, 'x')`,
          [id, position, type, start, end],
        );
      expect(await insert(0, 'agency', 2020, null)).toBe(CHECK);
      expect(await insert(0, COMPANY_TYPES[0], 2020, 2019)).toBe(CHECK);
      expect(await insert(0, COMPANY_TYPES[0], 2020, null)).toBeNull();
      expect(await insert(1, COMPANY_TYPES[1], 2018, null)).toBe(UNIQUE);
      expect(await insert(1, COMPANY_TYPES[1], 2018, 2020)).toBeNull();
    });
  });
});

describe('shortlists', () => {
  it('rejects an empty, blank, over-80-character or multi-line name', async () => {
    await inRollback(async (c) => {
      const company = await createCompany(c);
      const user = await createRecruiter(c, company);
      const insert = (name: string) =>
        sqlState(c, 'insert into public.shortlists (company_id, created_by, name) values ($1, $2, $3)', [company, user, name]);
      expect(await insert('')).toBe(CHECK);
      expect(await insert('   ')).toBe(CHECK);
      expect(await insert('a'.repeat(81))).toBe(CHECK);
      expect(await insert('two\nlines')).toBe(CHECK);
      expect(await insert('bell\u0007')).toBe(CHECK);
      expect(await insert('a'.repeat(80))).toBeNull();
      expect(await insert('Backend · NYC 🗽')).toBeNull();
    });
  });

  it("takes company_id and created_by from the signed-in recruiter", async () => {
    await inRollback(async (c) => {
      const company = await createCompany(c);
      const user = await createRecruiter(c, company);
      await actAs(c, user);
      const { rows } = await c.query("insert into public.shortlists (name) values ('Mine') returning company_id, created_by");
      expect(rows[0]).toEqual({ company_id: company, created_by: user });
    });
  });

  it('has no company to default to when nobody is signed in', async () => {
    await inRollback(async (c) => {
      expect(await sqlState(c, "insert into public.shortlists (name) values ('Orphan')")).toBe(NOT_NULL);
    });
  });

  it('bumps updated_at on rename', async () => {
    await inRollback(async (c) => {
      const company = await createCompany(c);
      const user = await createRecruiter(c, company);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.shortlists (company_id, created_by, name, created_at, updated_at)
         values ($1, $2, 'Old', '2000-01-01', '2000-01-01') returning id`,
        [company, user],
      );
      const { rows: after } = await c.query<{ bumped: boolean }>(
        "update public.shortlists set name = 'New' where id = $1 returning updated_at > '2000-01-01' as bumped",
        [rows[0]?.id],
      );
      expect(after[0]?.bumped).toBe(true);
    });
  });
});

describe('shortlist_people', () => {
  it("can't attach a member to another company's shortlist", async () => {
    await inRollback(async (c) => {
      const asterwell = await createCompany(c);
      const glenfold = await createCompany(c);
      const asterwellUser = await createRecruiter(c, asterwell);
      const glenfoldUser = await createRecruiter(c, glenfold);
      const person = await createCandidate(c);
      const { rows } = await c.query<{ id: string }>(
        "insert into public.shortlists (company_id, created_by, name) values ($1, $2, 'Asterwell list') returning id",
        [asterwell, asterwellUser],
      );
      const add = (companyId: string, by: string) =>
        sqlState(c, 'insert into public.shortlist_people (shortlist_id, candidate_id, company_id, added_by) values ($1, $2, $3, $4)', [
          rows[0]?.id,
          person,
          companyId,
          by,
        ]);
      expect(await add(glenfold, glenfoldUser)).toBe(FOREIGN_KEY);
      expect(await add(asterwell, asterwellUser)).toBeNull();
      expect(await add(asterwell, asterwellUser)).toBe(UNIQUE);
    });
  });
});

describe('saved_briefs', () => {
  const insert = async (c: Tx, brief: string, filters: string) => {
    const company = await createCompany(c);
    const user = await createRecruiter(c, company);
    return sqlState(c, 'insert into public.saved_briefs (company_id, created_by, brief, filters) values ($1, $2, $3, $4::jsonb)', [
      company,
      user,
      brief,
      filters,
    ]);
  };

  it('rejects filters that are not a JSON object', async () => {
    await inRollback(async (c) => {
      for (const filters of ['[]', '"roles"', '42', 'true', 'null']) {
        expect(await insert(c, 'senior React engineers', filters), filters).toBe(CHECK);
      }
      expect(await insert(c, 'senior React engineers', '{"roles": ["Frontend Engineer"]}')).toBeNull();
    });
  });

  it('rejects filters over 16 KB', async () => {
    await inRollback(async (c) => {
      expect(await insert(c, 'big', JSON.stringify({ pad: 'x'.repeat(16_384) }))).toBe(CHECK);
      expect(await insert(c, 'just under', JSON.stringify({ pad: 'x'.repeat(16_000) }))).toBeNull();
    });
  });

  it('rejects an empty, blank, over-1000-character or control-character brief', async () => {
    await inRollback(async (c) => {
      for (const brief of ['', ' \n\t ', 'a'.repeat(1001), 'bell\u0007', 'carriage\rreturn', 'c1\u0085control', 'del\u007f']) {
        expect(await insert(c, brief, '{}'), JSON.stringify(brief)).toBe(CHECK);
      }
      expect(await insert(c, 'a'.repeat(1000), '{}')).toBeNull();
      expect(await insert(c, 'line one\n\tline two — São Paulo 東京', '{}')).toBeNull();
    });
  });
});

describe('searches and search_results', () => {
  async function pendingSearch(c: Tx) {
    const company = await createCompany(c);
    const user = await createRecruiter(c, company);
    const { rows } = await c.query<{ id: string }>(
      "insert into public.searches (company_id, recruiter_id, brief, source) values ($1, $2, 'go engineers', 'brief') returning id",
      [company, user],
    );
    return { company, user, searchId: rows[0]?.id };
  }

  it('requires filters, total and completed_at once a search is done', async () => {
    await inRollback(async (c) => {
      const { searchId } = await pendingSearch(c);
      expect(await sqlState(c, "update public.searches set status = 'done' where id = $1", [searchId])).toBe(CHECK);
      expect(
        await sqlState(c, "update public.searches set status = 'done', filters = '{}', total = 0, completed_at = now() where id = $1", [
          searchId,
        ]),
      ).toBeNull();
      expect(await sqlState(c, "update public.searches set status = 'released' where id = $1", [searchId])).toBe(CHECK);
      expect(await sqlState(c, "update public.searches set source = 'api' where id = $1", [searchId])).toBe(CHECK);
    });
  });

  it("stores each candidate once per search and only under the search's own company", async () => {
    await inRollback(async (c) => {
      const { company, searchId } = await pendingSearch(c);
      const other = await createCompany(c);
      const [p1, p2] = [await createCandidate(c), await createCandidate(c)];
      const add = (rank: number, companyId: string, person: string | undefined) =>
        sqlState(c, 'insert into public.search_results (search_id, rank, company_id, candidate_id) values ($1, $2, $3, $4)', [
          searchId,
          rank,
          companyId,
          person,
        ]);
      expect(await add(1, other, p1)).toBe(FOREIGN_KEY);
      expect(await add(0, company, p1)).toBe(CHECK);
      expect(await add(1, company, p1)).toBeNull();
      expect(await add(1, company, p2)).toBe(UNIQUE);
      expect(await add(2, company, p1)).toBe(UNIQUE);
      expect(await add(2, company, p2)).toBeNull();
    });
  });
});

describe('company_usage', () => {
  it('never goes below zero', async () => {
    await inRollback(async (c) => {
      const company = await createCompany(c);
      expect(await sqlState(c, 'insert into public.company_usage (company_id, searches_used) values ($1, -1)', [company])).toBe(CHECK);
      expect(await sqlState(c, 'insert into public.company_usage (company_id) values ($1)', [company])).toBeNull();
    });
  });
});
