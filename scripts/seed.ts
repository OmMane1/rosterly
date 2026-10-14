// Idempotent seed (PLAN.md § 3.3 step 6): every candidate from data/candidates.json, the two
// companies with their usage rows, the recruiter auth users and their company links. Re-running it
// changes nothing; it never resets a company's searches_used.
//
// Candidates go over `pg` as one jsonb parameter that Postgres expands itself (static SQL, no
// string building). Users go through the auth admin API, so GoTrue owns their password hashes.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type User } from '@supabase/supabase-js';
import pg from 'pg';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '../lib/shared/demo-accounts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATES_FILE = path.join(ROOT, 'data', 'candidates.json');
const ENV_FILE = path.join(ROOT, '.env.local');

// Values already in the environment win over .env.local.
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run \`node scripts/write-env.mjs\` (or \`make setup\`) first.`);
  return value;
}

async function seedCandidates(client: pg.Client, json: string): Promise<void> {
  await client.query('begin');
  try {
    await client.query(
      `create temp table seed_src on commit drop as
         select value as c from jsonb_array_elements($1::jsonb)`,
      [json],
    );

    await client.query(`
      insert into public.candidates (id, full_name, avatar_url, headline, current_title, current_company,
        current_company_logo_url, role, seniority, years_experience, city, state, country, open_to_work, skills)
      select c->>'id', c->>'full_name', c->>'avatar_url', c->>'headline', c->>'current_title', c->>'current_company',
        c->>'current_company_logo_url', c->>'role', c->>'seniority', (c->>'years_experience')::smallint,
        c->'location'->>'city', c->'location'->>'state', c->'location'->>'country', (c->>'open_to_work')::boolean,
        array(select jsonb_array_elements_text(c->'skills'))
      from seed_src
      on conflict (id) do update set
        full_name = excluded.full_name, avatar_url = excluded.avatar_url, headline = excluded.headline,
        current_title = excluded.current_title, current_company = excluded.current_company,
        current_company_logo_url = excluded.current_company_logo_url, role = excluded.role,
        seniority = excluded.seniority, years_experience = excluded.years_experience, city = excluded.city,
        state = excluded.state, country = excluded.country, open_to_work = excluded.open_to_work,
        skills = excluded.skills
      where (candidates.*) is distinct from (excluded.*)`);

    // Array order is kept as `position`: experiences[0] is the current job.
    await client.query(`
      insert into public.candidate_experiences (candidate_id, position, title, company, company_type,
        company_logo_url, start_year, end_year, description)
      select c->>'id', e.ord - 1, e.x->>'title', e.x->>'company', e.x->>'company_type', e.x->>'company_logo_url',
        (e.x->>'start_year')::smallint, (e.x->>'end_year')::smallint, e.x->>'description'
      from seed_src, jsonb_array_elements(c->'experiences') with ordinality as e(x, ord)
      on conflict (candidate_id, position) do update set
        title = excluded.title, company = excluded.company, company_type = excluded.company_type,
        company_logo_url = excluded.company_logo_url, start_year = excluded.start_year,
        end_year = excluded.end_year, description = excluded.description
      where (candidate_experiences.*) is distinct from (excluded.*)`);

    await client.query(`
      insert into public.candidate_education (candidate_id, position, school, degree, field, graduation_year)
      select c->>'id', e.ord - 1, e.x->>'school', e.x->>'degree', e.x->>'field', (e.x->>'graduation_year')::smallint
      from seed_src, jsonb_array_elements(c->'education') with ordinality as e(x, ord)
      on conflict (candidate_id, position) do update set
        school = excluded.school, degree = excluded.degree, field = excluded.field,
        graduation_year = excluded.graduation_year
      where (candidate_education.*) is distinct from (excluded.*)`);

    // A candidate whose list got shorter in the data loses the extra rows, so the DB matches the file.
    await client.query(`
      delete from public.candidate_experiences t using seed_src
      where t.candidate_id = c->>'id' and t.position >= jsonb_array_length(c->'experiences')`);
    await client.query(`
      delete from public.candidate_education t using seed_src
      where t.candidate_id = c->>'id' and t.position >= jsonb_array_length(c->'education')`);

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}

async function seedCompanies(client: pg.Client): Promise<Map<string, string>> {
  const slugs = DEMO_ACCOUNTS.map((a) => a.slug);
  await client.query(
    `insert into public.companies (slug, name)
     select * from unnest($1::text[], $2::text[])
     on conflict (slug) do update set name = excluded.name
     where companies.name is distinct from excluded.name`,
    [slugs, DEMO_ACCOUNTS.map((a) => a.name)],
  );
  const { rows } = await client.query<{ id: string; slug: string }>('select id, slug from public.companies where slug = any($1)', [slugs]);
  // Usage starts at 0 and is never reset here: re-seeding must not hand out a new free search.
  await client.query('insert into public.company_usage (company_id) select unnest($1::uuid[]) on conflict do nothing', [rows.map((r) => r.id)]);
  return new Map(rows.map((r) => [r.slug, r.id]));
}

async function ensureUsers(url: string, secretKey: string): Promise<Map<string, string>> {
  const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const existing: User[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listing auth users failed: ${error.message}`);
    existing.push(...data.users);
    if (data.users.length < 1000) break;
  }

  const ids = new Map<string, string>();
  for (const account of DEMO_ACCOUNTS) {
    const found = existing.find((u) => u.email?.toLowerCase() === account.email);
    if (found) {
      ids.set(account.email, found.id);
      continue;
    }
    const { data, error } = await admin.auth.admin.createUser({ email: account.email, password: DEMO_PASSWORD, email_confirm: true });
    if (error) throw new Error(`creating ${account.email} failed: ${error.message}`);
    ids.set(account.email, data.user.id);
  }
  return ids;
}

async function seedRecruiters(client: pg.Client, companies: Map<string, string>, users: Map<string, string>): Promise<void> {
  const pairs = DEMO_ACCOUNTS.map((a) => {
    const userId = users.get(a.email);
    const companyId = companies.get(a.slug);
    if (!userId || !companyId) throw new Error(`missing user or company for ${a.slug}`);
    return [userId, companyId] as const;
  });
  await client.query(
    `insert into public.recruiters (user_id, company_id)
     select * from unnest($1::uuid[], $2::uuid[])
     on conflict (user_id) do update set company_id = excluded.company_id
     where recruiters.company_id is distinct from excluded.company_id`,
    [pairs.map(([u]) => u), pairs.map(([, c]) => c)],
  );
}

async function counts(client: pg.Client): Promise<Record<string, number>> {
  const { rows } = await client.query<Record<string, number>>(`
    select (select count(*) from public.candidates)::int as candidates,
           (select count(*) from public.candidate_experiences)::int as experiences,
           (select count(*) from public.candidate_education)::int as education,
           (select count(*) from public.companies)::int as companies,
           (select count(*) from public.recruiters)::int as recruiters`);
  return rows[0] ?? {};
}

async function main(): Promise<void> {
  const started = performance.now();
  const json = readFileSync(CANDIDATES_FILE, 'utf8');
  const client = new pg.Client({ connectionString: env('DATABASE_URL') });
  await client.connect();
  try {
    await seedCandidates(client, json);
    const companies = await seedCompanies(client);
    const users = await ensureUsers(env('SUPABASE_URL'), env('SUPABASE_SECRET_KEY'));
    await seedRecruiters(client, companies, users);
    const c = await counts(client);
    const summary = Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`✔ seeded in ${((performance.now() - started) / 1000).toFixed(1)} s: ${summary}`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`✖ seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
