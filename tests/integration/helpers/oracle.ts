// A reference implementation of private.match_candidates over data/candidates.json, written
// separately from the SQL. When the two agree on ordered ids for hand-written cases, both follow
// PLAN.md § 3.4 instead of sharing one bug.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hasSubstantiveFilter, type ExperienceCondition, type Filters } from '@/lib/shared/filters';

type Experience = { company: string; company_type: string; end_year: number | null; description: string };
type Education = { school: string; degree: string; field: string; graduation_year: number };
type Candidate = {
  id: string;
  role: string;
  seniority: string;
  years_experience: number;
  location: { city: string; state: string };
  open_to_work: boolean;
  skills: string[];
  experiences: Experience[];
  education: Education[];
};

export const CANDIDATES = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../data/candidates.json'), 'utf8')) as Candidate[];

const given = <T>(values: readonly T[] | undefined): values is readonly T[] => (values?.length ?? 0) > 0;
// Vocabulary-typed lists widened to string[], so a data value can be looked up in them.
const among = (values: readonly string[] | undefined, value: string) => values?.includes(value) ?? false;

function jobMatches(job: Experience, cond: ExperienceCondition): boolean {
  return (cond.company_type === undefined || job.company_type === cond.company_type) && (!given(cond.employers) || among(cond.employers, job.company));
}

function holds(c: Candidate, cond: ExperienceCondition): boolean {
  const jobs = c.experiences.filter((job) => jobMatches(job, cond));
  const current = jobs.some((job) => job.end_year === null);
  switch (cond.when) {
    case 'any':
      return jobs.length > 0;
    case 'current':
      return current;
    case 'past':
      return jobs.some((job) => job.end_year !== null) && !current;
    case 'never':
      return jobs.length === 0;
  }
}

// Whole word, case-sensitive, the needle taken literally.
function mentions(text: string, needle: string): boolean {
  const literal = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${literal}($|[^\\p{L}\\p{N}])`, 'u').test(text);
}

function matches(c: Candidate, f: Filters): boolean {
  const { city, state } = c.location;
  const x = f.exclude ?? {};
  const educationAsked = given(f.schools) || given(f.degrees) || given(f.fields) || f.graduated_min !== undefined || f.graduated_max !== undefined;
  return (
    (!given(f.roles) || among(f.roles, c.role)) &&
    (!given(f.seniority) || among(f.seniority, c.seniority)) &&
    (!(given(f.cities) || given(f.states)) || among(f.cities, city) || among(f.states, state)) &&
    (!given(f.skills_all) || f.skills_all.every((s) => c.skills.includes(s))) &&
    (!given(f.skills_any) || f.skills_any.some((s) => c.skills.includes(s))) &&
    (f.open_to_work === undefined || c.open_to_work === f.open_to_work) &&
    (f.years_min === undefined || c.years_experience >= f.years_min) &&
    (f.years_max === undefined || c.years_experience <= f.years_max) &&
    (f.experience ?? []).every((cond) => holds(c, cond)) &&
    (!educationAsked ||
      c.education.some(
        (d) =>
          (!given(f.schools) || among(f.schools, d.school)) &&
          (!given(f.degrees) || among(f.degrees, d.degree)) &&
          (!given(f.fields) || among(f.fields, d.field)) &&
          (f.graduated_min === undefined || d.graduation_year >= f.graduated_min) &&
          (f.graduated_max === undefined || d.graduation_year <= f.graduated_max),
      )) &&
    !among(x.roles, c.role) &&
    !among(x.cities, city) &&
    !among(x.states, state) &&
    !(x.skills ?? []).some((s) => c.skills.includes(s)) &&
    !c.education.some((d) => among(x.schools, d.school) || among(x.degrees, d.degree)) &&
    !c.experiences.some((job) => among(x.employers, job.company))
  );
}

/** The ids private.match_candidates must return, in rank order. */
export function expectedIds(f: Filters): string[] {
  if ((f.unsupported?.length ?? 0) > 0 || !hasSubstantiveFilter(f)) return [];
  const anyOf = [...new Set(f.skills_any ?? [])];
  const requested = [...new Set([...(f.skills_all ?? []), ...anyOf])];
  const scored = CANDIDATES.filter((c) => matches(c, f)).map((c) => {
    const current = c.experiences.find((job) => job.end_year === null);
    return {
      id: c.id,
      key: [
        anyOf.filter((s) => c.skills.includes(s)).length,
        requested.filter((s) => c.skills.includes(s) && current !== undefined && mentions(current.description, s)).length,
        (f.experience ?? []).filter((cond) => (cond.when === 'any' || cond.when === 'current') && current !== undefined && jobMatches(current, cond)).length,
        c.open_to_work ? 1 : 0,
        c.years_experience,
      ],
    };
  });
  if (scored.length === CANDIDATES.length) return [];
  scored.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      const d = (b.key[i] ?? 0) - (a.key[i] ?? 0);
      if (d !== 0) return d;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return scored.map((s) => s.id);
}
