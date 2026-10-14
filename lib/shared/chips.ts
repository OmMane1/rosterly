// The understood filters as chips (PLAN.md § 3.9): what each chip says, which editor it opens, and
// the pure edits behind × and the editors. Shared by the search page, saved searches and the tests,
// so a chip always describes exactly what the SQL will match.
import { normalizeFilters, type ExperienceCondition, type Exclusions, type Filters, type Unsupported } from './filters';
import { ROLES, type Seniority, type State } from './vocabulary.generated';

export const SENIORITY_LABELS: Record<Seniority, string> = { junior: 'Junior', mid: 'Mid-level', senior: 'Senior', staff: 'Staff' };

// "New York" and "Washington" are also a city and a university, so those states say "State".
export const STATE_NAMES: Record<State, string> = {
  CA: 'California',
  CO: 'Colorado',
  FL: 'Florida',
  GA: 'Georgia',
  IL: 'Illinois',
  MA: 'Massachusetts',
  NY: 'New York State',
  TX: 'Texas',
  WA: 'Washington State',
};

export const WHEN_LABELS: Record<ExperienceCondition['when'], string> = {
  any: 'Worked at',
  current: 'Currently at',
  past: 'Formerly at',
  never: 'Never at',
};

export type ExcludeKey = keyof Exclusions;

/** What the chip is about: picks its icon. */
export type ChipKind = 'seniority' | 'role' | 'skill' | 'location' | 'years' | 'experience' | 'open_to_work' | 'education' | 'exclude';

/** The editor a chip opens. Experience conditions are edited one at a time. */
export type EditorTarget =
  | { field: 'roles' | 'seniority' | 'location' | 'skills_all' | 'skills_any' | 'years' | 'open_to_work' | 'schools' | 'degrees' | 'fields' | 'graduated' }
  | { field: 'experience'; index: number | null }
  | { field: 'exclude'; key: ExcludeKey };

export type FilterChip = {
  /** Stable for equal content, so a draft can be compared with the search it edits. */
  key: string;
  kind: ChipKind;
  label: string;
  editor: EditorTarget;
};

/** "A", "A or B", "A, B or C", "A, B or 3 more". */
export function joinOr(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length <= 3) return `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;
  return `${values.slice(0, 2).join(', ')} or ${values.length - 2} more`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function yearsLabel(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return min === max ? plural(min, 'year') : `${min}–${max} years`;
  if (min !== undefined) return `${min}+ years`;
  return `Up to ${plural(max ?? 0, 'year')}`;
}

export function graduatedLabel(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return min === max ? `Graduated in ${min}` : `Graduated ${min}–${max}`;
  if (min !== undefined) return `Graduated ${min} or later`;
  return `Graduated ${max} or earlier`;
}

export function experienceLabel(c: ExperienceCondition): string {
  const type = c.company_type === 'startup' ? 'a startup' : c.company_type === 'enterprise' ? 'an enterprise' : undefined;
  const employers = c.employers?.length ? joinOr(c.employers) : undefined;
  const target = employers && c.company_type ? `${employers} (${c.company_type})` : (employers ?? type ?? 'any company');
  return `${WHEN_LABELS[c.when]} ${target}`;
}

const EXCLUDE_LABEL: Record<ExcludeKey, (v: string) => string> = {
  roles: (v) => `Not ${v}`,
  cities: (v) => `Not in ${v}`,
  states: (v) => `Not in ${STATE_NAMES[v as State] ?? v}`,
  skills: (v) => `Without ${v}`,
  schools: (v) => `Not from ${v}`,
  degrees: (v) => `No ${v}`,
  employers: (v) => `Never at ${v}`,
};
const EXCLUDE_KEYS = Object.keys(EXCLUDE_LABEL) as ExcludeKey[];

// "Engineers" means all of these (PLAN.md § 3.4 mapping table); seven chips would bury the rest.
const ENGINEERING_ROLES: readonly string[] = ROLES.filter((r) => r.endsWith(' Engineer'));
/** Four or more roles share one chip. */
const ROLE_GROUP_FROM = 4;

const experienceKey = (c: ExperienceCondition) => `experience:${c.when}:${c.company_type ?? ''}:${(c.employers ?? []).join('|')}`;

/** The filter chips, in reading order: "Senior · Frontend Engineer · React · New York · 6+ years…". */
export function filterChips(f: Filters): FilterChip[] {
  const chips: FilterChip[] = [];
  const each = (values: readonly string[] | undefined, kind: ChipKind, field: string, editor: EditorTarget, label = (v: string) => v) => {
    for (const v of values ?? []) chips.push({ key: `${field}:${v}`, kind, label: label(v), editor });
  };
  each(f.seniority, 'seniority', 'seniority', { field: 'seniority' }, (v) => SENIORITY_LABELS[v as Seniority] ?? v);
  if ((f.roles?.length ?? 0) >= ROLE_GROUP_FROM && f.roles) {
    const allEngineering = f.roles.length === ENGINEERING_ROLES.length && ENGINEERING_ROLES.every((r) => f.roles?.includes(r as never));
    chips.push({ key: `roles:${f.roles.join('|')}`, kind: 'role', label: allEngineering ? 'Any engineering role' : joinOr(f.roles), editor: { field: 'roles' } });
  } else each(f.roles, 'role', 'roles', { field: 'roles' });
  each(f.skills_all, 'skill', 'skills_all', { field: 'skills_all' });
  if (f.skills_any?.length) chips.push({ key: `skills_any:${f.skills_any.join('|')}`, kind: 'skill', label: joinOr(f.skills_any), editor: { field: 'skills_any' } });
  each(f.cities, 'location', 'cities', { field: 'location' });
  each(f.states, 'location', 'states', { field: 'location' }, (v) => STATE_NAMES[v as State] ?? v);
  if (f.years_min !== undefined || f.years_max !== undefined) {
    chips.push({ key: `years:${f.years_min ?? ''}-${f.years_max ?? ''}`, kind: 'years', label: yearsLabel(f.years_min, f.years_max), editor: { field: 'years' } });
  }
  f.experience?.forEach((c, index) => chips.push({ key: experienceKey(c), kind: 'experience', label: experienceLabel(c), editor: { field: 'experience', index } }));
  if (f.open_to_work !== undefined) {
    chips.push({ key: `open_to_work:${f.open_to_work}`, kind: 'open_to_work', label: f.open_to_work ? 'Open to work' : 'Not open to work', editor: { field: 'open_to_work' } });
  }
  each(f.schools, 'education', 'schools', { field: 'schools' });
  each(f.degrees, 'education', 'degrees', { field: 'degrees' });
  each(f.fields, 'education', 'fields', { field: 'fields' }, (v) => `Studied ${v}`);
  if (f.graduated_min !== undefined || f.graduated_max !== undefined) {
    chips.push({
      key: `graduated:${f.graduated_min ?? ''}-${f.graduated_max ?? ''}`,
      kind: 'education',
      label: graduatedLabel(f.graduated_min, f.graduated_max),
      editor: { field: 'graduated' },
    });
  }
  for (const key of EXCLUDE_KEYS) each(f.exclude?.[key], 'exclude', `exclude.${key}`, { field: 'exclude', key }, EXCLUDE_LABEL[key]);
  return chips;
}

const without = <T>(values: readonly T[] | undefined, v: T) => values?.filter((x) => x !== v);

/** × on a chip: drops exactly what that chip stands for. */
export function removeChip(f: Filters, key: string): Filters {
  const sep = key.indexOf(':');
  const field = sep < 0 ? key : key.slice(0, sep);
  const value = sep < 0 ? '' : key.slice(sep + 1);
  const next: Filters = { ...f };
  switch (field) {
    case 'seniority':
      next.seniority = without(f.seniority, value as Seniority);
      break;
    case 'roles':
      next.roles = value.includes('|') ? undefined : without(f.roles, value as (typeof ROLES)[number]);
      break;
    case 'cities':
    case 'states':
    case 'skills_all':
    case 'schools':
    case 'degrees':
    case 'fields':
      (next as Record<string, unknown>)[field] = without(f[field] as readonly string[] | undefined, value);
      break;
    case 'skills_any':
      delete next.skills_any;
      break;
    case 'years':
      delete next.years_min;
      delete next.years_max;
      break;
    case 'graduated':
      delete next.graduated_min;
      delete next.graduated_max;
      break;
    case 'open_to_work':
      delete next.open_to_work;
      break;
    case 'experience':
      next.experience = f.experience?.filter((c) => experienceKey(c) !== key);
      break;
    default: {
      const excludeKey = field.startsWith('exclude.') ? (field.slice('exclude.'.length) as ExcludeKey) : undefined;
      if (excludeKey && f.exclude && EXCLUDE_KEYS.includes(excludeKey)) {
        next.exclude = { ...f.exclude, [excludeKey]: without(f.exclude[excludeKey] as readonly string[] | undefined, value) };
      }
    }
  }
  return normalizeFilters(next);
}

export const unsupportedKey = (u: Unsupported) => `unsupported:${u.text}|${u.reason}`;

/** × on a warning chip. The rest of the brief can then be searched. */
export function removeUnsupported(f: Filters, index: number): Filters {
  return normalizeFilters({ ...f, unsupported: f.unsupported?.filter((_, i) => i !== index) });
}

/** The one-tap fix ("principal" → Staff): the suggested values replace the warning. */
export function applySuggestion(f: Filters, index: number): Filters {
  const s = f.unsupported?.[index]?.suggestion;
  if (!s) return f;
  const current = (f[s.field] ?? []) as string[];
  return normalizeFilters({ ...removeUnsupported(f, index), [s.field]: [...current, ...s.values] });
}

/** Drops every warning: "search the rest of the brief". */
export function withoutUnsupported(f: Filters): Filters {
  return normalizeFilters({ ...f, unsupported: undefined });
}

/** How many chips a draft adds, removes or changes compared with the search it edits. */
export function countChanges(applied: Filters, draft: Filters): number {
  const chipMap = (f: Filters) =>
    new Map<string, string>([...filterChips(f).map((c) => [c.key, c.label] as const), ...(f.unsupported ?? []).map((u) => [unsupportedKey(u), u.text] as const)]);
  const a = chipMap(applied);
  const d = chipMap(draft);
  let n = 0;
  for (const [k, label] of a) if (d.get(k) !== label) n++;
  for (const k of d.keys()) if (!a.has(k)) n++;
  return n;
}

/** The chips of `applied` that the draft drops, shown struck through until the draft is applied. */
export function removedChips(applied: Filters, draft: Filters): FilterChip[] {
  const kept = new Set(filterChips(draft).map((c) => c.key));
  return filterChips(applied).filter((c) => !kept.has(c.key));
}

/** The keys of draft chips that the applied search doesn't have yet. */
export function addedChipKeys(applied: Filters, draft: Filters): Set<string> {
  const had = new Set(filterChips(applied).map((c) => c.key));
  return new Set(filterChips(draft).map((c) => c.key).filter((k) => !had.has(k)));
}

/** Skills a result card highlights: the ones the search asked for. */
export function requestedSkills(f: Filters): Set<string> {
  return new Set([...(f.skills_all ?? []), ...(f.skills_any ?? [])]);
}

/** Equal for equal filters whatever their key order (jsonb reorders keys), so a saved search can be recognised. */
export function filtersKey(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(filtersKey).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${filtersKey(x)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
