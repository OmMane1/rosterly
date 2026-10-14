import 'server-only';
// What the model must return (PLAN.md § 3.4 "LlmFilters"), and its conversion to canonical Filters.
// Every filter value is an enum built from the generated vocabulary, so the model can't name
// something the data doesn't have. Every field is required and non-nullable (empty array = no
// constraint, sentinels for "no bound"), which keeps the grammar small and the output predictable.
// The only free text is the brief's own words in unsupported/ignored, which postprocess checks.
import { z } from 'zod';
import { EXPERIENCE_WHEN, MAX_EXPERIENCE_CONDITIONS, MAX_VALUES, type ExperienceCondition, type Filters } from '@/lib/shared/filters';
import { sanitizeText } from '@/lib/shared/sanitize';
import { CITIES, COMPANY_TYPES, DEGREES, EMPLOYERS, FIELDS, ROLES, SCHOOLS, SENIORITIES, SKILLS, STATES } from '@/lib/shared/vocabulary.generated';
import { REASON_CODES, REASONS } from './unsupported';

/** Sentinels: the model can't omit a field, so "no bound" is a value outside every real range. */
export const NO_YEARS_MIN = 0;
export const NO_YEARS_MAX = 99;
export const NO_GRADUATED_MIN = 0;
export const NO_GRADUATED_MAX = 9999;

const MAX_UNSUPPORTED = 12;
const MAX_IGNORED = 20;

// Named enums become $defs, so each vocabulary appears once in the schema the model sees.
const registry = z.registry<{ id?: string; description?: string }>();
const named = <T extends readonly [string, ...string[]]>(id: string, values: T) => z.enum(values).register(registry, { id });
const described = <S extends z.ZodType>(schema: S, description: string): S => {
  registry.add(schema, { description });
  return schema;
};

const Role = named('Role', ROLES);
const Seniority = named('Seniority', SENIORITIES);
const City = named('City', CITIES);
const State = named('State', STATES);
const Skill = named('Skill', SKILLS);
const Employer = named('Employer', EMPLOYERS);
const School = named('School', SCHOOLS);
const Degree = named('Degree', DEGREES);
const Field = named('Field', FIELDS);

// unsupported and ignored come first: the model sets aside what it can't map before it fills the
// enums, which makes an enum-forced guess (London → New York) less likely.
export const LlmFilters = z.strictObject({
  unsupported: described(
    z.array(z.strictObject({ text: z.string(), reason: z.enum(REASON_CODES) })),
    'Constraints the data cannot answer, each quoting the brief. Any entry means zero results.',
  ),
  ignored: described(z.array(z.string()), 'Words copied from the brief that add no filter.'),
  roles: z.array(Role),
  seniority: z.array(Seniority),
  cities: z.array(City),
  states: z.array(State),
  skills_all: z.array(Skill),
  skills_any: z.array(Skill),
  open_to_work: z.enum(['any', 'yes', 'no']),
  years_min: described(z.int(), `Inclusive minimum years of experience; ${NO_YEARS_MIN} = no minimum.`),
  years_max: described(z.int(), `Inclusive maximum years of experience; ${NO_YEARS_MAX} = no maximum.`),
  experience: z.array(
    z.strictObject({
      company_type: z.enum(['any', ...COMPANY_TYPES]),
      employers: z.array(Employer),
      when: z.enum(EXPERIENCE_WHEN),
    }),
  ),
  schools: z.array(School),
  degrees: z.array(Degree),
  fields: z.array(Field),
  graduated_min: described(z.int(), `Earliest graduation year; ${NO_GRADUATED_MIN} = no bound.`),
  graduated_max: described(z.int(), `Latest graduation year; ${NO_GRADUATED_MAX} = no bound.`),
  exclude: z.strictObject({
    roles: z.array(Role),
    cities: z.array(City),
    states: z.array(State),
    skills: z.array(Skill),
    schools: z.array(School),
    degrees: z.array(Degree),
    employers: z.array(Employer),
  }),
});
export type LlmFilters = z.infer<typeof LlmFilters>;

// Keywords structured outputs doesn't accept (numeric bounds, $schema). z.int() always emits the
// safe-integer bounds; the real bounds are applied in toFilters.
const UNSUPPORTED_KEYWORDS = new Set(['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).filter(([k]) => !UNSUPPORTED_KEYWORDS.has(k)).map(([k, v]) => [k, strip(v)]));
}

let jsonSchema: Record<string, unknown> | undefined;

/**
 * The JSON schema sent as output_config.format. Built from LlmFilters directly rather than with the
 * SDK's zodOutputFormat, which (in 0.131.0) moves `enum` into the description and so would stop the
 * grammar from constraining values to the vocabulary.
 */
export function llmJsonSchema(): Record<string, unknown> {
  jsonSchema ??= strip(z.toJSONSchema(LlmFilters, { metadata: registry, reused: 'ref', io: 'output' })) as Record<string, unknown>;
  return jsonSchema;
}

// ---- conversion to canonical Filters ----

/** Sanitised, one line, and within the canonical length. A plain cut keeps it a quote of the brief. */
function tidy(value: string, max: number): string {
  return sanitizeText(value).replace(/\s+/g, ' ').trim().slice(0, max).toWellFormed();
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const capped = <T>(values: readonly T[]): T[] | undefined => (values.length ? values.slice(0, MAX_VALUES) : undefined);

function experience(items: LlmFilters['experience']): ExperienceCondition[] | undefined {
  const out = items
    .map((c) => ({
      ...(c.company_type !== 'any' ? { company_type: c.company_type } : {}),
      ...(c.employers.length ? { employers: c.employers.slice(0, MAX_VALUES) } : {}),
      when: c.when,
    }))
    // A condition with neither a type nor an employer says nothing about where someone worked.
    .filter((c) => 'company_type' in c || 'employers' in c)
    .slice(0, MAX_EXPERIENCE_CONDITIONS);
  return out.length ? out : undefined;
}

/**
 * Sentinels become absent fields, bounds are clamped and reason codes become fixed sentences.
 * Nothing is grounded or dropped here, and a blank unsupported entry is kept (dropping it would
 * widen the result); postprocess decides what text may be shown.
 */
export function toFilters(llm: LlmFilters): Filters {
  const x = llm.exclude;
  const exclude = {
    roles: capped(x.roles),
    cities: capped(x.cities),
    states: capped(x.states),
    skills: capped(x.skills),
    schools: capped(x.schools),
    degrees: capped(x.degrees),
    employers: capped(x.employers),
  };
  const unsupported = llm.unsupported.slice(0, MAX_UNSUPPORTED).map((u) => ({ text: tidy(u.text, 200) || '-', reason: REASONS[u.reason] }));
  const ignored = llm.ignored.map((w) => tidy(w, 100)).filter(Boolean).slice(0, MAX_IGNORED);
  return {
    roles: capped(llm.roles),
    seniority: capped(llm.seniority),
    cities: capped(llm.cities),
    states: capped(llm.states),
    skills_all: capped(llm.skills_all),
    skills_any: capped(llm.skills_any),
    open_to_work: llm.open_to_work === 'any' ? undefined : llm.open_to_work === 'yes',
    years_min: llm.years_min <= NO_YEARS_MIN ? undefined : clamp(llm.years_min, 0, 99),
    years_max: llm.years_max >= NO_YEARS_MAX ? undefined : clamp(llm.years_max, 0, 99),
    experience: experience(llm.experience),
    schools: capped(llm.schools),
    degrees: capped(llm.degrees),
    fields: capped(llm.fields),
    graduated_min: llm.graduated_min <= NO_GRADUATED_MIN ? undefined : clamp(llm.graduated_min, 1900, 2100),
    graduated_max: llm.graduated_max >= NO_GRADUATED_MAX ? undefined : clamp(llm.graduated_max, 1900, 2100),
    exclude: Object.values(exclude).some(Boolean) ? exclude : undefined,
    unsupported: unsupported.length ? unsupported : undefined,
    ignored: ignored.length ? ignored : undefined,
  };
}
