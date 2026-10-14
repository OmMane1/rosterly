// M2 acceptance: `npm run seed` loads all of data/candidates.json losslessly, creates both
// companies and their recruiters through the auth admin API, and changes nothing when re-run.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify, isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS } from '@/lib/shared/demo-accounts';
import { closeDb, db } from './helpers/db';
import { publicClient, signIn } from './helpers/supabase';

type Candidate = { id: string; experiences: unknown[]; education: unknown[] };

const ROOT = path.resolve(import.meta.dirname, '../..');
const run = promisify(execFile);
const candidates = (JSON.parse(readFileSync(path.join(ROOT, 'data/candidates.json'), 'utf8')) as Candidate[]).sort((a, b) =>
  a.id < b.id ? -1 : 1,
);

async function seed(): Promise<string> {
  const { stdout } = await run(path.join(ROOT, 'node_modules/.bin/tsx'), ['scripts/seed.ts'], { cwd: ROOT, timeout: 120_000 });
  return stdout;
}

// Every count and id the seed is responsible for, so a re-run can be compared exactly.
async function snapshot() {
  const { rows: [counts] } = await db().query<Record<string, number>>(`
    select (select count(*) from public.candidates)::int as candidates,
           (select count(*) from public.candidate_experiences)::int as experiences,
           (select count(*) from public.candidate_education)::int as education,
           (select count(*) from public.companies)::int as companies,
           (select count(*) from public.recruiters)::int as recruiters,
           (select count(*) from public.company_usage)::int as company_usage,
           (select count(*) from auth.users)::int as users`);
  const { rows: links } = await db().query<{ slug: string; company_id: string; email: string; user_id: string; searches_used: number }>(`
    select co.slug, co.id as company_id, u.email, u.id as user_id, cu.searches_used
    from public.companies co
    left join public.recruiters r on r.company_id = co.id
    left join auth.users u on u.id = r.user_id
    left join public.company_usage cu on cu.company_id = co.id
    order by co.slug`);
  return { counts, links };
}

beforeAll(async () => {
  await seed();
}, 120_000);

afterAll(async () => {
  await closeDb();
});

describe('seed', () => {
  it('loads every candidate, experience and education row', async () => {
    const { counts } = await snapshot();
    expect(counts).toMatchObject({ candidates: 5000, experiences: 14344, education: 5000 });
    expect(counts?.experiences).toBe(candidates.reduce((n, c) => n + c.experiences.length, 0));
    expect(counts?.education).toBe(candidates.reduce((n, c) => n + c.education.length, 0));
  });

  it('stores candidates losslessly: rebuilt rows equal data/candidates.json', async () => {
    const { rows } = await db().query<{ c: Candidate }>(`
      select jsonb_build_object(
        'id', c.id, 'full_name', c.full_name, 'avatar_url', c.avatar_url, 'headline', c.headline,
        'current_title', c.current_title, 'current_company', c.current_company,
        'current_company_logo_url', c.current_company_logo_url, 'role', c.role, 'seniority', c.seniority,
        'years_experience', c.years_experience,
        'location', jsonb_build_object('city', c.city, 'state', c.state, 'country', c.country),
        'open_to_work', c.open_to_work, 'skills', to_jsonb(c.skills),
        'experiences', (select jsonb_agg(jsonb_build_object(
            'title', e.title, 'company', e.company, 'company_logo_url', e.company_logo_url,
            'company_type', e.company_type, 'start_year', e.start_year, 'end_year', e.end_year,
            'description', e.description) order by e.position)
          from public.candidate_experiences e where e.candidate_id = c.id),
        'education', (select jsonb_agg(jsonb_build_object(
            'school', d.school, 'degree', d.degree, 'field', d.field, 'graduation_year', d.graduation_year)
            order by d.position)
          from public.candidate_education d where d.candidate_id = c.id)
      ) as c
      from public.candidates c`);
    const rebuilt = rows.map((r) => r.c).sort((a, b) => (a.id < b.id ? -1 : 1));

    expect(rebuilt).toHaveLength(candidates.length);
    const first = rebuilt.findIndex((c, i) => !isDeepStrictEqual(c, candidates[i]));
    // On failure, show just the first differing candidate rather than a 6 MB diff.
    if (first !== -1) expect(rebuilt[first]).toEqual(candidates[first]);
  });

  it('creates both companies, each with exactly one recruiter and a usage row', async () => {
    const { counts, links } = await snapshot();
    expect(counts).toMatchObject({ companies: 2, recruiters: 2, company_usage: 2 });
    expect(links.map(({ slug, email }) => ({ slug, email }))).toEqual(DEMO_ACCOUNTS.map(({ slug, email }) => ({ slug, email })));
  });

  it('both recruiters sign in with supabase-js as their seeded user', async () => {
    const { links } = await snapshot();
    for (const account of DEMO_ACCOUNTS) {
      const session = await signIn(account.email);
      expect(session.userId).toBe(links.find((l) => l.slug === account.slug)?.user_id);
    }
  });

  it('rejects a wrong password', async () => {
    const { error } = await publicClient().auth.signInWithPassword({ email: DEMO_ACCOUNTS[0].email, password: 'wrong-password' });
    expect(error?.status).toBe(400);
  });

  // The CLI exposes no env var for sign_in_sign_ups (DECISIONS.md), so the raised limit is checked
  // by behaviour: the e2e and security suites sign in many times within GoTrue's 5-minute window.
  it('allows 50 back-to-back sign-ins', async () => {
    for (let i = 0; i < 50; i++) await signIn(DEMO_ACCOUNTS[i % 2]?.email ?? DEMO_ACCOUNTS[0].email);
  }, 60_000);

  it('re-running changes no count, no id, and never resets searches_used', async () => {
    const asterwell = DEMO_ACCOUNTS[0].slug;
    await db().query('update public.company_usage set searches_used = searches_used + 1 where company_id = (select id from public.companies where slug = $1)', [asterwell]);
    try {
      const before = await snapshot();
      await seed();
      expect(await snapshot()).toEqual(before);
    } finally {
      await db().query('update public.company_usage set searches_used = searches_used - 1 where company_id = (select id from public.companies where slug = $1)', [asterwell]);
    }
  }, 120_000);
});
