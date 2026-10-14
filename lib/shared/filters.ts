// Canonical search filters (PLAN.md § 3.4): the one shape shared by the API, the UI chips, saved
// briefs and SQL (private.match_candidates). Every value comes from the generated vocabulary, so a
// filter can't name something the data doesn't have.
import { z } from 'zod';
import {
  CITIES,
  COMPANY_TYPES,
  DEGREES,
  EMPLOYERS,
  FIELDS,
  ROLES,
  SCHOOLS,
  SENIORITIES,
  SKILLS,
  STATES,
} from './vocabulary.generated';

/** Same cap as private.filter_list in SQL. */
export const MAX_VALUES = 50;
export const MAX_EXPERIENCE_CONDITIONS = 10;
/** Same cap as the filters CHECK constraints on searches and saved_briefs. */
export const MAX_FILTERS_BYTES = 16_384;

const list = <T extends readonly [string, ...string[]]>(values: T) => z.array(z.enum(values)).max(MAX_VALUES);

export const EXPERIENCE_WHEN = ['any', 'current', 'past', 'never'] as const;

/**
 * One condition on the candidate's jobs; company_type and employers apply to the same job.
 * any = some job matches; current = the current job matches; past = an ended job matches and the
 * current one doesn't ("ex-X"); never = no job matches.
 */
export const ExperienceCondition = z
  .strictObject({
    company_type: z.enum(COMPANY_TYPES).optional(),
    employers: list(EMPLOYERS).optional(),
    when: z.enum(EXPERIENCE_WHEN),
  })
  .refine((c) => c.company_type !== undefined || (c.employers?.length ?? 0) > 0, {
    message: 'an experience condition needs a company type or at least one employer',
  });
export type ExperienceCondition = z.infer<typeof ExperienceCondition>;

export const Exclusions = z.strictObject({
  roles: list(ROLES).optional(),
  cities: list(CITIES).optional(),
  states: list(STATES).optional(),
  skills: list(SKILLS).optional(),
  schools: list(SCHOOLS).optional(),
  degrees: list(DEGREES).optional(),
  employers: list(EMPLOYERS).optional(),
});
export type Exclusions = z.infer<typeof Exclusions>;

// A one-tap fix for an unsupported item, only when a true nearest value exists (principal → staff).
const suggestion = <F extends string, T extends readonly [string, ...string[]]>(field: F, values: T) =>
  z.strictObject({ field: z.literal(field), values: list(values).min(1) });
export const Suggestion = z.discriminatedUnion('field', [
  suggestion('roles', ROLES),
  suggestion('seniority', SENIORITIES),
  suggestion('cities', CITIES),
  suggestion('states', STATES),
  suggestion('skills_all', SKILLS),
  suggestion('skills_any', SKILLS),
  suggestion('schools', SCHOOLS),
  suggestion('degrees', DEGREES),
  suggestion('fields', FIELDS),
]);
export type Suggestion = z.infer<typeof Suggestion>;

/** A constraint the data can't answer: any entry makes the result empty (policy rule 1). */
export const Unsupported = z.strictObject({
  text: z.string().min(1).max(200),
  reason: z.string().min(1).max(300),
  suggestion: Suggestion.optional(),
});
export type Unsupported = z.infer<typeof Unsupported>;

const year = z.int().min(1900).max(2100);
const years = z.int().min(0).max(99);

export const Filters = z
  .strictObject({
    roles: list(ROLES).optional(),
    seniority: list(SENIORITIES).optional(),
    /** Location matches when the city is in `cities` or the state is in `states`. */
    cities: list(CITIES).optional(),
    states: list(STATES).optional(),
    skills_all: list(SKILLS).optional(),
    skills_any: list(SKILLS).optional(),
    open_to_work: z.boolean().optional(),
    /** Inclusive. min > max is allowed and simply matches nobody. */
    years_min: years.optional(),
    years_max: years.optional(),
    experience: z.array(ExperienceCondition).max(MAX_EXPERIENCE_CONDITIONS).optional(),
    /** schools, degrees, fields and graduation years apply to the same education row. */
    schools: list(SCHOOLS).optional(),
    degrees: list(DEGREES).optional(),
    fields: list(FIELDS).optional(),
    graduated_min: year.optional(),
    graduated_max: year.optional(),
    exclude: Exclusions.optional(),
    unsupported: z.array(Unsupported).max(20).optional(),
    /** Puffery the parser dropped ("rockstar"); shown as a note, never filtered on. */
    ignored: z.array(z.string().min(1).max(100)).max(MAX_VALUES).optional(),
  })
  .refine((f) => new TextEncoder().encode(JSON.stringify(f)).length <= MAX_FILTERS_BYTES, {
    message: `filters must be at most ${MAX_FILTERS_BYTES} bytes as JSON`,
  });
export type Filters = z.infer<typeof Filters>;

/**
 * True when some constraint narrows the set. Exclusions alone, ignored words and unsupported items
 * don't count, so "nothing ever returns everyone" (policy rule 6). Mirrors the SQL guard.
 */
export function hasSubstantiveFilter(f: Filters): boolean {
  const lists = [f.roles, f.seniority, f.cities, f.states, f.skills_all, f.skills_any, f.schools, f.degrees, f.fields, f.experience];
  if (lists.some((l) => (l?.length ?? 0) > 0)) return true;
  return [f.open_to_work, f.years_min, f.years_max, f.graduated_min, f.graduated_max].some((v) => v !== undefined);
}

/** Policy rule 1: one unanswerable constraint empties the whole answer. */
export function isUnanswerable(f: Filters): boolean {
  return (f.unsupported?.length ?? 0) > 0;
}

// Vocabulary order, so equal filters serialise identically (stable chips, saved briefs, cache keys).
function ordered<T extends string>(values: readonly T[] | undefined, vocabulary: readonly T[]): T[] | undefined {
  if (!values?.length) return undefined;
  const wanted = new Set(values);
  return vocabulary.filter((v) => wanted.has(v));
}

function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Dedupes and orders every list and drops empty ones. Doesn't change what the filters match. */
export function normalizeFilters(f: Filters): Filters {
  const exclude = f.exclude
    ? compact({
        roles: ordered(f.exclude.roles, ROLES),
        cities: ordered(f.exclude.cities, CITIES),
        states: ordered(f.exclude.states, STATES),
        skills: ordered(f.exclude.skills, SKILLS),
        schools: ordered(f.exclude.schools, SCHOOLS),
        degrees: ordered(f.exclude.degrees, DEGREES),
        employers: ordered(f.exclude.employers, EMPLOYERS),
      })
    : undefined;
  const seen = new Set<string>();
  const experience = f.experience
    ?.map((c) => compact({ company_type: c.company_type, employers: ordered(c.employers, EMPLOYERS), when: c.when }))
    .filter((c) => {
      const key = JSON.stringify(c);
      return seen.has(key) ? false : (seen.add(key), true);
    });
  return compact({
    roles: ordered(f.roles, ROLES),
    seniority: ordered(f.seniority, SENIORITIES),
    cities: ordered(f.cities, CITIES),
    states: ordered(f.states, STATES),
    skills_all: ordered(f.skills_all, SKILLS),
    skills_any: ordered(f.skills_any, SKILLS),
    open_to_work: f.open_to_work,
    years_min: f.years_min,
    years_max: f.years_max,
    experience: experience?.length ? experience : undefined,
    schools: ordered(f.schools, SCHOOLS),
    degrees: ordered(f.degrees, DEGREES),
    fields: ordered(f.fields, FIELDS),
    graduated_min: f.graduated_min,
    graduated_max: f.graduated_max,
    exclude: exclude && Object.keys(exclude).length > 0 ? exclude : undefined,
    unsupported: f.unsupported?.length ? f.unsupported : undefined,
    ignored: f.ignored?.length ? [...new Set(f.ignored)] : undefined,
  });
}
