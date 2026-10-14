import 'server-only';
// Deterministic clean-up after the model (PLAN.md § 3.4 step 5): screen the model's text, keep
// stated levels, drop constraints that are true for everyone (rule 4), and ground every proper-noun
// value in the brief (rule 5). A value the brief never mentions is an enum-forced guess (London → "New York"): it
// moves to `unsupported`, which empties the result and tells the recruiter why.
import { Filters, normalizeFilters, type ExperienceCondition, type Unsupported } from '@/lib/shared/filters';
import { findMentions, type LexiconCategory } from '@/lib/shared/lexicon';
import { sanitizeText } from '@/lib/shared/sanitize';
import {
  CITIES,
  CITY_STATE,
  DEGREES,
  FIELDS,
  GRADUATION_YEARS,
  ROLES,
  SCHOOLS,
  SENIORITIES,
  SKILLS,
  YEARS_EXPERIENCE,
  type City,
  type Seniority,
  type State,
} from '@/lib/shared/vocabulary.generated';
import { REASON_TEXTS, REASONS, suggestionFor, unappliedLevel, UNQUOTED_TEXT } from './unsupported';

/** The longest stretch of the brief echoed back in unsupported or ignored. */
export const MAX_ECHO = 60;

export type Conversion = {
  field: string;
  value: string;
  action: 'unsupported' | 'dropped' | 'replaced';
  reason: string;
};

export type Postprocessed = {
  filters: Filters;
  /** Every value moved or dropped, for the eval and for debugging. */
  conversions: Conversion[];
  /** Logged only: roles the brief doesn't name literally (e.g. the "engineers" expansion). */
  notes: string[];
};

// ---- model text ----

// Letters and digits only, lowercased: a quote may differ from the brief in case, spacing and
// punctuation, but every word must be the brief's, in the brief's order.
const words = (s: string) => sanitizeText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// The model sees the brief as a JSON string with < and > escaped (prompt.ts briefMessage) and may
// quote it with those escapes; decode them so a faithful quote counts, then sanitise the result.
const decoded = (text: string) =>
  sanitizeText(
    text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t'),
  );
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).toWellFormed()}…`);

/**
 * The model's only free text is unsupported[].text and ignored[], and both are shown to the
 * recruiter, so a brief could ask the model to copy its instructions into them. Text survives only
 * if it quotes the brief (then it's cut to MAX_ECHO); reasons must be one of the fixed sentences;
 * suggestions come only from the fixed table. An unsupported entry is never dropped, since that
 * would widen the result: its text is replaced instead.
 */
function screen(brief: string, raw: Filters, conversions: Conversion[]): Pick<Filters, 'unsupported' | 'ignored'> {
  const briefWords = ` ${words(brief)} `;
  const quotes = (text: string) => words(text) !== '' && briefWords.includes(` ${words(text)} `);
  const seen = new Set<string>();
  const unsupported = (raw.unsupported ?? []).flatMap((entry) => {
    const u = { ...entry, text: decoded(entry.text) };
    const quoted = quotes(u.text);
    if (!quoted) conversions.push({ field: 'unsupported.text', value: clip(u.text, 40), action: 'replaced', reason: 'not a quote of the brief' });
    const text = quoted ? clip(u.text, MAX_ECHO) : UNQUOTED_TEXT;
    const reason = REASON_TEXTS.has(u.reason) ? u.reason : REASONS.other;
    const suggestion = quoted ? suggestionFor(u.text) : undefined;
    const key = `${words(text)}\u0000${reason}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ text, reason, ...(suggestion ? { suggestion } : {}) }];
  });
  const ignored = new Map<string, string>();
  for (const w of (raw.ignored ?? []).map(decoded)) {
    if (!quotes(w)) conversions.push({ field: 'ignored', value: clip(w, 40), action: 'dropped', reason: 'not a quote of the brief' });
    else if (!ignored.has(words(w))) ignored.set(words(w), clip(w, MAX_ECHO));
  }
  return { unsupported, ignored: [...ignored.values()] };
}

// ---- stated levels ----

// The level phrases of the mapping table, as whole words. A bare "mid" is left out ("mid-size").
const word = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'giu');
const LEVELS: readonly { value: Seniority; pattern: RegExp }[] = [
  { value: 'junior', pattern: word('juniors?|entry[\\s-]?level|new[\\s-]?grads?|early[\\s-]?career') },
  { value: 'mid', pattern: word('mid[\\s-]?level') },
  { value: 'senior', pattern: word('seniors?') },
  { value: 'staff', pattern: word('staff') },
];
const NEGATIONS = new Set(['not', 'no', 'non', 'without']);
const NEEDS = new Set(["doesn't", 'doesnt', "don't", 'dont']);

// Negated when "not", "no", "non-" or "without" is one of the three words before the level, or
// "doesn't/don't need" ends within them ("doesn't need to be senior").
function negated(brief: string, start: number): boolean {
  const before = brief.slice(0, start).toLowerCase().replace(/[‘’]/g, "'");
  if (/non[\s-]*$/.test(before)) return true;
  const tokens = before.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  if (tokens.slice(-3).some((t) => NEGATIONS.has(t))) return true;
  const last = tokens.slice(-4);
  return last.some((t, i) => NEEDS.has(t) && last[i + 1] === 'need' && i + 1 >= last.length - 3);
}

/**
 * A level the brief states (not negated) but the answer has no seniority for, and doesn't quote in
 * unsupported or ignored, was dropped by the model, e.g. "junior" in "junior engineers with 15+
 * years", which it sometimes "resolves" by keeping only the years. Each becomes an unsupported
 * entry, so the result is empty with a reason instead of the wrong people.
 */
function unappliedLevels(brief: string, raw: Filters, quoted: readonly string[]): { value: Seniority; text: string }[] {
  if (raw.seniority?.length) return [];
  const covered = (text: string) => quoted.some((q) => ` ${words(q)} `.includes(` ${words(text)} `));
  const found = new Map<string, { value: Seniority; text: string }>();
  for (const { value, pattern } of LEVELS) {
    for (const m of brief.matchAll(pattern)) {
      if (!negated(brief, m.index) && !covered(m[0]) && !found.has(m[0].toLowerCase())) found.set(m[0].toLowerCase(), { value, text: m[0] });
    }
  }
  return [...found.values()];
}

// ---- grounding ----

type Mentioned = (category: LexiconCategory, value: string) => boolean;

function mentionIndex(brief: string): Mentioned {
  const seen = new Set(findMentions(brief).map((m) => `${m.category}\u0000${m.value}`));
  return (category, value) => seen.has(`${category}\u0000${value}`);
}

class Grounder {
  readonly conversions: Conversion[] = [];
  readonly unsupported: Unsupported[] = [];

  constructor(private readonly mentioned: Mentioned) {}

  /** Keeps the values the brief mentions; the rest become unsupported. */
  keep<T extends string>(field: string, category: LexiconCategory, values: readonly T[] | undefined): T[] | undefined {
    if (!values?.length) return values ? [] : undefined;
    return values.filter((value) => {
      if (this.mentioned(category, value)) return true;
      this.reject(field, value);
      return false;
    });
  }

  /**
   * Cities and states ground each other: a state the brief doesn't name, added next to one of its
   * cities, would widen "Los Angeles" to all of CA, so it's dropped; a city added under a named
   * state changes nothing, so it's dropped too. Anything else ungrounded becomes unsupported.
   */
  location(scope: string, cities: readonly City[] | undefined, states: readonly State[] | undefined) {
    const named = (cities ?? []).filter((c) => this.mentioned('city', c));
    const namedStates = (states ?? []).filter((s) => this.mentioned('state', s));
    const keptStates = (states ?? []).filter((s) => {
      if (namedStates.includes(s)) return true;
      if (named.some((c) => CITY_STATE[c] === s)) return this.drop(`${scope}states`, s, 'implied by a city in the brief');
      this.reject(`${scope}states`, s);
      return false;
    });
    const keptCities = (cities ?? []).filter((c) => {
      if (named.includes(c)) return true;
      if (namedStates.includes(CITY_STATE[c])) return this.drop(`${scope}cities`, c, 'covered by a state in the brief');
      this.reject(`${scope}cities`, c);
      return false;
    });
    return { cities: keptCities, states: keptStates };
  }

  experience(conditions: readonly ExperienceCondition[] | undefined): ExperienceCondition[] | undefined {
    return conditions
      ?.map((c) => ({ ...c, employers: this.keep('experience.employers', 'employer', c.employers) }))
      .filter((c) => c.company_type !== undefined || (c.employers?.length ?? 0) > 0);
  }

  drop(field: string, value: string, reason: string): false {
    this.conversions.push({ field, value, action: 'dropped', reason });
    return false;
  }

  private reject(field: string, value: string) {
    const reason = `Couldn't match “${value}” to anything in the brief.`;
    this.conversions.push({ field, value, action: 'unsupported', reason });
    this.unsupported.push({ text: value, reason });
  }
}

// Rule 4: a list naming every value of its vocabulary, or a bound outside the data's range,
// narrows nothing.
function everyone<T extends string>(g: Grounder, field: string, values: readonly T[] | undefined, vocabulary: readonly T[]): T[] | undefined {
  if (!values?.length) return undefined;
  if (vocabulary.every((v) => values.includes(v))) {
    g.drop(field, values.join(', '), 'true for everyone');
    return undefined;
  }
  return [...values];
}

function bound(g: Grounder, field: string, value: number | undefined, isEveryone: (n: number) => boolean): number | undefined {
  if (value === undefined || !isEveryone(value)) return value;
  g.drop(field, String(value), 'true for everyone');
  return undefined;
}

/** The final, valid Filters for a brief, plus what was changed and why. Throws only on a bug. */
export function postprocess(brief: string, raw: Filters): Postprocessed {
  const mentioned = mentionIndex(brief);
  const g = new Grounder(mentioned);
  const screened = screen(brief, raw, g.conversions);
  const levels = unappliedLevels(brief, raw, [...(screened.unsupported ?? []).map((u) => u.text), ...(screened.ignored ?? [])]).map(({ text }) => {
    g.conversions.push({ field: 'seniority', value: text, action: 'unsupported', reason: 'a level the brief states is missing from the answer' });
    return { text, reason: unappliedLevel(text) };
  });
  const x = raw.exclude ?? {};

  const location = g.location('', raw.cities, raw.states);
  const excludedLocation = g.location('exclude.', x.cities, x.states);
  const filters: Filters = {
    ...raw,
    ...location,
    skills_all: g.keep('skills_all', 'skill', raw.skills_all),
    skills_any: g.keep('skills_any', 'skill', raw.skills_any),
    schools: g.keep('schools', 'school', raw.schools),
    experience: g.experience(raw.experience),
    exclude: {
      ...x,
      ...excludedLocation,
      skills: g.keep('exclude.skills', 'skill', x.skills),
      schools: g.keep('exclude.schools', 'school', x.schools),
      employers: g.keep('exclude.employers', 'employer', x.employers),
    },
  };

  // Location narrows nothing when the cities and the states' cities together cover every city.
  const covered = new Set<City>([...(filters.cities ?? []), ...CITIES.filter((c) => filters.states?.includes(CITY_STATE[c]))]);
  if (covered.size === CITIES.length) {
    g.drop('cities/states', [...(filters.cities ?? []), ...(filters.states ?? [])].join(', '), 'true for everyone');
    filters.cities = undefined;
    filters.states = undefined;
  }
  filters.roles = everyone(g, 'roles', filters.roles, ROLES);
  filters.seniority = everyone(g, 'seniority', filters.seniority, SENIORITIES);
  filters.skills_any = everyone(g, 'skills_any', filters.skills_any, SKILLS);
  filters.schools = everyone(g, 'schools', filters.schools, SCHOOLS);
  filters.degrees = everyone(g, 'degrees', filters.degrees, DEGREES);
  filters.fields = everyone(g, 'fields', filters.fields, FIELDS);
  filters.years_min = bound(g, 'years_min', filters.years_min, (n) => n <= YEARS_EXPERIENCE.min);
  filters.years_max = bound(g, 'years_max', filters.years_max, (n) => n >= YEARS_EXPERIENCE.max);
  filters.graduated_min = bound(g, 'graduated_min', filters.graduated_min, (n) => n <= GRADUATION_YEARS.min);
  filters.graduated_max = bound(g, 'graduated_max', filters.graduated_max, (n) => n >= GRADUATION_YEARS.max);

  const unsupported = [...(screened.unsupported ?? []), ...levels, ...g.unsupported].slice(0, 20);
  filters.unsupported = unsupported.length ? unsupported : undefined;
  filters.ignored = screened.ignored;

  const notes = (filters.roles ?? []).filter((r) => !mentioned('role', r)).map((r) => `role not named in the brief: ${r}`);
  return { filters: Filters.parse(normalizeFilters(filters)), conversions: g.conversions, notes };
}
