import 'server-only';
// Why a constraint can't be answered, and the only one-tap fixes ever offered. The model picks a
// reason code and quotes the brief; every sentence a recruiter reads comes from this file, so model-
// written prose (or anything the model was told, such as this prompt) never reaches the API or UI.
import type { Suggestion } from '@/lib/shared/filters';
import { CITIES, EMPLOYERS, ROLES, SCHOOLS, SKILLS } from '@/lib/shared/vocabulary.generated';

export const REASONS = {
  language: 'The candidate data has no languages.',
  work_arrangement: 'The candidate data has no remote, hybrid, on-site or relocation preference.',
  compensation: 'The candidate data has no salary or compensation.',
  work_authorization: 'The candidate data has no visa, citizenship or clearance status.',
  industry: 'The candidate data has no industry or domain.',
  tenure: 'The candidate data has no time in a job or tenure.',
  demographics: 'Search never filters on age, gender, ethnicity or similar traits.',
  leadership: 'The candidate data has no management or leadership experience.',
  place: `All candidates are in one of ${CITIES.length} US cities, and this place isn't one of them.`,
  employer: `This employer isn't one of the ${EMPLOYERS.length} in the candidate data.`,
  school: `This school isn't one of the ${SCHOOLS.length} in the candidate data.`,
  skill: `This skill isn't one of the ${SKILLS.length} in the candidate data.`,
  role: `This role isn't one of the ${ROLES.length} in the candidate data.`,
  level: 'The levels in the data are junior, mid, senior and staff.',
  inexpressible: "This can't be expressed with the available filters.",
  other: "The candidate data doesn't record this.",
} as const;
export type ReasonCode = keyof typeof REASONS;
export const REASON_CODES = Object.keys(REASONS) as [ReasonCode, ...ReasonCode[]];
export const REASON_TEXTS: ReadonlySet<string> = new Set(Object.values(REASONS));

/** The level guard's reason: the brief states a level the model's answer leaves out. */
export const unappliedLevel = (text: string) => `The brief asks for “${text}”, which couldn't be applied, so no one is shown rather than the wrong people.`;

/** Shown instead of model text that doesn't quote the brief; the entry itself is kept (rule 1). */
export const UNQUOTED_TEXT = 'Part of the brief';

// A suggestion only where one value is a true nearest equivalent (CLAUDE.md § Search rules, rule 1).
const SUGGESTIONS: readonly { pattern: RegExp; suggestion: Suggestion }[] = [
  { pattern: /\bprincipal\b/i, suggestion: { field: 'seniority', values: ['staff'] } },
  { pattern: /\b(?:sres?|site reliability)\b/i, suggestion: { field: 'roles', values: ['DevOps Engineer'] } },
];

export function suggestionFor(text: string): Suggestion | undefined {
  return SUGGESTIONS.find((s) => s.pattern.test(text))?.suggestion;
}
