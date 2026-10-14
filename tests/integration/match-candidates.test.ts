// M4 acceptance: private.match_candidates returns the exact set, in a deterministic rank order, for
// hand-written cases (checked against the TypeScript oracle) and for the 10 held-out briefs' gold
// filters (checked against queries.json). It returns nothing rather than everyone, and rejects
// malformed filters with 23514 (→ 400).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Filters } from '@/lib/shared/filters';
import { SENIORITIES } from '@/lib/shared/vocabulary.generated';
import { closeDb, db, inRollback, sqlState } from './helpers/db';
import { CANDIDATES, expectedIds } from './helpers/oracle';

const ROOT = path.resolve(import.meta.dirname, '../..');
const readJson = <T>(file: string) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as T;

afterAll(closeDb);

async function match(filters: unknown): Promise<string[]> {
  const { rows } = await db().query<{ candidate_id: string; rank: number }>(
    'select candidate_id, rank from private.match_candidates($1::jsonb) order by rank',
    [JSON.stringify(filters)],
  );
  // Ranks are 1..n with no gaps, so pages can be primary-key range scans.
  expect(rows.map((r) => r.rank)).toEqual(rows.map((_, i) => i + 1));
  return rows.map((r) => r.candidate_id);
}

type Case = { name: string; filters: Filters; empty?: true };

const CASES: Case[] = [
  { name: 'roles: any of', filters: { roles: ['Recruiter', 'Product Manager'] } },
  { name: 'seniority: any of', filters: { roles: ['Backend Engineer'], seniority: ['senior', 'staff'] } },
  { name: 'cities only', filters: { cities: ['Denver'] } },
  { name: 'states only (CA = San Francisco + Los Angeles)', filters: { states: ['CA'] } },
  { name: 'location union: the city or the state', filters: { roles: ['Data Scientist'], cities: ['Boston'], states: ['TX'] } },
  { name: 'skills_all: every skill', filters: { skills_all: ['Python', 'SQL'] } },
  { name: 'skills_any: at least one, more matches rank higher', filters: { skills_any: ['Rust', 'Scala', 'Go', 'Kafka'] } },
  { name: 'Go and R match exactly those skills', filters: { skills_any: ['Go', 'R'] } },
  { name: 'open_to_work: false', filters: { roles: ['Recruiter'], open_to_work: false } },
  { name: 'years: inclusive bounds', filters: { roles: ['Data Engineer'], years_min: 4, years_max: 7 } },
  { name: 'years contradicting seniority → empty', filters: { seniority: ['junior'], years_min: 10 }, empty: true },
  { name: 'experience any: has worked at a startup', filters: { roles: ['Data Engineer'], experience: [{ company_type: 'startup', when: 'any' }] } },
  { name: 'experience current: currently at an employer', filters: { experience: [{ employers: ['Corvane'], when: 'current' }] } },
  { name: 'experience past: ex-employer, not there now', filters: { experience: [{ employers: ['Corvane'], when: 'past' }] } },
  { name: 'experience never: never at an enterprise', filters: { roles: ['Frontend Engineer'], experience: [{ company_type: 'enterprise', when: 'never' }] } },
  {
    name: 'experience: company type and employer apply to the same job',
    filters: { experience: [{ company_type: 'enterprise', employers: ['Corvane', 'Fizzbit'], when: 'current' }] },
  },
  {
    name: 'experience: a startup type with an enterprise employer matches no job → empty',
    filters: { experience: [{ company_type: 'startup', employers: ['Corvane'], when: 'any' }] },
    empty: true,
  },
  {
    name: 'experience: two conditions, ex-startup and now at an enterprise',
    filters: { experience: [{ company_type: 'startup', when: 'past' }, { company_type: 'enterprise', when: 'current' }] },
  },
  { name: 'education: school and degree', filters: { schools: ['MIT'], degrees: ['MS', 'PhD'] } },
  { name: 'education: field and graduation years on the same row', filters: { fields: ['Design'], graduated_min: 2018, graduated_max: 2020 } },
  {
    name: 'exclude: cities, skills and employers',
    filters: { roles: ['Backend Engineer'], exclude: { cities: ['New York'], skills: ['Java'], employers: ['Corvane'] } },
  },
  {
    name: 'exclude: roles, states, schools and degrees',
    filters: { seniority: ['staff'], exclude: { roles: ['Recruiter'], states: ['CA'], schools: ['MIT'], degrees: ['MBA'] } },
  },
  {
    name: 'ranking: skills_any count, then skills in the current job, then a current-job experience match',
    filters: {
      roles: ['Backend Engineer', 'DevOps Engineer'],
      skills_any: ['Go', 'Kubernetes', 'Postgres', 'Terraform'],
      experience: [{ company_type: 'startup', when: 'any' }],
    },
  },
];

describe('hand-written cases, against the TypeScript oracle', () => {
  it.each(CASES)('$name', async ({ filters, empty }) => {
    expect(Filters.safeParse(filters).success).toBe(true);
    const expected = expectedIds(filters);
    // Neither side may pass by being empty, or by returning everyone.
    if (empty) expect(expected).toEqual([]);
    else expect(expected.length).toBeGreaterThan(0);
    expect(await match(filters)).toEqual(expected);
  });

  it('covers every filter field at least once', () => {
    const used = new Set(CASES.flatMap(({ filters }) => [...Object.keys(filters), ...Object.keys(filters.exclude ?? {}).map((k) => `exclude.${k}`)]));
    const fields = Object.keys(Filters.shape).filter((k) => !['unsupported', 'ignored', 'exclude'].includes(k));
    const exclusions = ['roles', 'cities', 'states', 'skills', 'schools', 'degrees', 'employers'].map((k) => `exclude.${k}`);
    expect([...fields, ...exclusions].filter((k) => !used.has(k))).toEqual([]);
    const whens = new Set(CASES.flatMap(({ filters }) => filters.experience?.map((c) => c.when) ?? []));
    expect([...whens].sort()).toEqual(['any', 'current', 'never', 'past']);
  });

  it('is deterministic: the same filters give the same order every time', async () => {
    const filters = CASES.at(-1)?.filters ?? {};
    const runs = [await match(filters), await match(filters), await match(filters)];
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});

describe('gold filters for the held-out briefs', () => {
  const queries = readJson<{ brief: string; expected_ids: string[] }[]>('data/queries.json');
  const gold = readJson<{ brief: string; filters: unknown }[]>('eval/gold-filters.json');

  it('exist for every brief in queries.json', () => {
    expect(gold.map((g) => g.brief).sort()).toEqual(queries.map((q) => q.brief).sort());
  });

  it.each(queries)('P = R = 1: $brief', async ({ brief, expected_ids }) => {
    const filters = Filters.parse(gold.find((g) => g.brief === brief)?.filters);
    const ids = await match(filters);
    const expected = new Set(expected_ids);
    const hits = ids.filter((id) => expected.has(id)).length;
    expect({ precision: ids.length ? hits / ids.length : 1, recall: expected.size ? hits / expected.size : 1 }).toEqual({ precision: 1, recall: 1 });
    expect(ids).toHaveLength(expected.size);
  });
});

describe('returns nothing rather than everyone', () => {
  const unsupported = [{ text: 'speak Japanese', reason: 'The candidate data has no languages.' }];
  const nothing: [string, unknown][] = [
    ['empty filters', {}],
    ['only empty lists', { roles: [], skills_all: [], experience: [] }],
    ['only ignored words', { ignored: ['rockstar', 'ninja'] }],
    ['only exclusions', { exclude: { roles: ['Recruiter'] } }],
    ['an unsupported item next to a real filter', { roles: ['Product Manager'], unsupported }],
    ['constraints true for everyone: years ≤ 99', { years_max: 99 }],
    ['constraints true for everyone: every seniority', { seniority: [...SENIORITIES] }],
    ['constraints true for everyone: years ≥ 0', { years_min: 0 }],
  ];

  it.each(nothing)('%s', async (_, filters) => {
    expect(await match(filters)).toEqual([]);
  });

  it('still returns a large real set (no accidental cap)', async () => {
    const ids = await match({ years_min: 1 });
    expect(ids.length).toBe(CANDIDATES.filter((c) => c.years_experience >= 1).length);
    expect(ids.length).toBeLessThan(CANDIDATES.length);
  });
});

describe('malformed filters', () => {
  const malformed: [string, unknown][] = [
    ['an array', []],
    ['a string', 'Recruiter'],
    ['a list field that is a string', { roles: 'Recruiter' }],
    ['a list with a number', { roles: [1] }],
    ['a list over 50 values', { skills_any: Array.from({ length: 51 }, () => 'Go') }],
    ['years as a string', { years_min: '5' }],
    ['years with a fraction', { years_min: 2.5 }],
    ['negative years', { years_min: -1 }],
    ['open_to_work as a string', { open_to_work: 'yes' }],
    ['experience as an object', { experience: { when: 'any' } }],
    ['an unknown experience "when"', { experience: [{ company_type: 'startup', when: 'sometime' }] }],
    ['an experience condition with no type and no employer', { experience: [{ when: 'any' }] }],
    ['an experience condition with an empty employer list', { experience: [{ when: 'never', employers: [] }] }],
    ['exclude as a list', { exclude: ['Recruiter'] }],
    ['unsupported as a string', { unsupported: 'Japanese' }],
  ];

  it.each(malformed)('rejects %s with 23514, as zod does', async (_, filters) => {
    expect(Filters.safeParse(filters).success).toBe(false);
    const code = await inRollback((client) => sqlState(client, 'select * from private.match_candidates($1::jsonb)', [JSON.stringify(filters)]));
    expect(code).toBe('23514');
  });
});
