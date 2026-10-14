'use client';
// The editor behind each chip and behind "+ Filter". Every choice comes from the generated
// vocabulary, so an edit can only ever produce a filter the data has (CLAUDE.md § Search rules).
import { Search } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/components/ui/cn';
import { SENIORITY_LABELS, STATE_NAMES, type EditorTarget, type ExcludeKey } from '@/lib/shared/chips';
import { EXPERIENCE_WHEN, normalizeFilters, type ExperienceCondition, type Filters } from '@/lib/shared/filters';
import {
  CITIES,
  CITY_STATE,
  DEGREES,
  EMPLOYER_TYPE,
  EMPLOYERS,
  FIELDS,
  GRADUATION_YEARS,
  ROLES,
  SCHOOLS,
  SENIORITIES,
  SENIORITY_YEARS,
  SKILLS,
  STATES,
  YEARS_EXPERIENCE,
  type City,
  type CompanyType,
  type Degree,
  type Employer,
  type State,
} from '@/lib/shared/vocabulary.generated';

export type EditorParts = { body: ReactNode; footer: ReactNode };

type Common = {
  filters: Filters;
  /** Receives the whole new filter set. */
  onApply: (next: Filters) => void;
  onCancel: () => void;
  applyLabel: string;
  layout: (parts: EditorParts) => ReactNode;
};

const EXCLUDE_TITLES: Record<ExcludeKey, string> = {
  roles: 'Exclude roles',
  cities: 'Exclude cities',
  states: 'Exclude states',
  skills: 'Exclude skills',
  schools: 'Exclude schools',
  degrees: 'Exclude degrees',
  employers: 'Exclude employers',
};

export function editorTitle(t: EditorTarget): { title: string; description?: string } {
  switch (t.field) {
    case 'roles':
      return { title: 'Role', description: 'People in any of these roles.' };
    case 'seniority':
      return { title: 'Level', description: 'Levels follow years of experience in this data.' };
    case 'location':
      return { title: 'Location', description: 'People in any of these cities or states.' };
    case 'skills_all':
      return { title: 'Skills', description: 'People who have all of these.' };
    case 'skills_any':
      return { title: 'Any of these skills', description: 'People who have at least one.' };
    case 'years':
      return { title: 'Years of experience' };
    case 'open_to_work':
      return { title: 'Open to work' };
    case 'experience':
      return { title: 'Company history', description: 'Where they work or have worked.' };
    case 'schools':
      return { title: 'School' };
    case 'degrees':
      return { title: 'Degree' };
    case 'fields':
      return { title: 'Field of study' };
    case 'graduated':
      return { title: 'Graduation year' };
    case 'exclude':
      return { title: EXCLUDE_TITLES[t.key], description: 'Leave out anyone who matches.' };
  }
}

export function FilterEditor({ target, ...common }: Common & { target: EditorTarget }) {
  const f = common.filters;
  const set = (patch: Partial<Filters>) => normalizeFilters({ ...f, ...patch });
  switch (target.field) {
    case 'roles':
      return <MultiEditor {...common} options={ROLES} initial={f.roles} build={(roles) => set({ roles })} />;
    case 'seniority':
      return (
        <MultiEditor
          {...common}
          options={SENIORITIES}
          initial={f.seniority}
          label={(v) => SENIORITY_LABELS[v]}
          hint={(v) => `${SENIORITY_YEARS[v].min}–${SENIORITY_YEARS[v].max} years`}
          build={(seniority) => set({ seniority })}
        />
      );
    case 'location':
      return <LocationEditor {...common} />;
    case 'skills_all':
      return <MultiEditor {...common} options={SKILLS} initial={f.skills_all} searchable build={(skills_all) => set({ skills_all })} />;
    case 'skills_any':
      return <MultiEditor {...common} options={SKILLS} initial={f.skills_any} searchable build={(skills_any) => set({ skills_any })} />;
    case 'schools':
      return <MultiEditor {...common} options={SCHOOLS} initial={f.schools} build={(schools) => set({ schools })} />;
    case 'degrees':
      return <MultiEditor {...common} options={DEGREES} initial={f.degrees} hint={degreeHint} build={(degrees) => set({ degrees })} />;
    case 'fields':
      return <MultiEditor {...common} options={FIELDS} initial={f.fields} build={(fields) => set({ fields })} />;
    case 'years':
      return (
        <RangeEditor
          {...common}
          unit="years"
          min={YEARS_EXPERIENCE.min}
          max={YEARS_EXPERIENCE.max}
          initial={[f.years_min, f.years_max]}
          build={([years_min, years_max]) => set({ years_min, years_max })}
        />
      );
    case 'graduated':
      return (
        <RangeEditor
          {...common}
          unit="year"
          min={GRADUATION_YEARS.min}
          max={GRADUATION_YEARS.max}
          initial={[f.graduated_min, f.graduated_max]}
          build={([graduated_min, graduated_max]) => set({ graduated_min, graduated_max })}
        />
      );
    case 'open_to_work':
      return <OpenToWorkEditor {...common} />;
    case 'experience':
      return <ExperienceEditor {...common} index={target.index} />;
    case 'exclude':
      return <ExcludeEditor {...common} excludeKey={target.key} />;
  }
}

const degreeHint = (d: Degree) => ({ BS: 'Bachelor of Science', BA: 'Bachelor of Arts', MS: 'Master of Science', MBA: 'Master of Business Administration', PhD: 'Doctorate' })[d];

// ---- building blocks ----

function Footer({ onCancel, onApply, applyLabel, error, onClear }: { onCancel: () => void; onApply: () => void; applyLabel: string; error?: string | null; onClear?: () => void }) {
  return (
    <div>
      {error && (
        <p role="alert" className="mb-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        {onClear && (
          <Button variant="ghost" size="sm" onClick={onClear} className="-ml-2 text-stone-600">
            Clear
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onCancel} className="ml-auto">
          Cancel
        </Button>
        <Button size="sm" onClick={onApply}>
          {applyLabel}
        </Button>
      </div>
    </div>
  );
}

function OptionList<T extends string>({
  options,
  selected,
  onToggle,
  label = (v) => v,
  hint,
  searchable,
  heading,
}: {
  options: readonly T[];
  selected: ReadonlySet<T>;
  onToggle: (v: T, on: boolean) => void;
  label?: (v: T) => string;
  hint?: (v: T) => string | undefined;
  searchable?: boolean;
  heading?: string;
}) {
  const [query, setQuery] = useState('');
  const id = useId();
  // Long lists open with what's already chosen at the top (fixed at open, so ticking doesn't reorder).
  const [order] = useState(() => (options.length > 8 ? [...options.filter((o) => selected.has(o)), ...options.filter((o) => !selected.has(o))] : options));
  const q = query.trim().toLowerCase();
  const shown = q ? order.filter((o) => label(o).toLowerCase().includes(q)) : order;
  return (
    <fieldset>
      {heading && <legend className="mb-1.5 text-xs font-semibold tracking-wide text-stone-500 uppercase">{heading}</legend>}
      {searchable && (
        <div className="relative mb-2">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
          <label htmlFor={id} className="sr-only">
            Find
          </label>
          <input
            id={id}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Find among ${options.length}`}
            autoComplete="off"
            className="h-11 w-full rounded-lg bg-stone-50 pr-3 pl-9 text-base ring-1 ring-stone-200 ring-inset outline-none placeholder:text-stone-400 focus:bg-white focus:ring-2 focus:ring-indigo-600 sm:h-9 sm:text-sm"
          />
        </div>
      )}
      <ul className="-mx-2">
        {shown.map((o) => (
          <li key={o}>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-stone-50 sm:min-h-9">
              <Checkbox checked={selected.has(o)} onCheckedChange={(v) => onToggle(o, v === true)} />
              <span className="min-w-0 flex-1 text-sm">{label(o)}</span>
              {hint?.(o) && <span className="shrink-0 text-xs text-stone-500">{hint(o)}</span>}
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="px-2 py-3 text-sm text-stone-500">Nothing matches “{query}”. The data has no such value.</li>}
      </ul>
    </fieldset>
  );
}

function useSelection<T extends string>(initial: readonly T[] | undefined) {
  const [selected, setSelected] = useState<Set<T>>(() => new Set(initial ?? []));
  const toggle = (v: T, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(v);
      else n.delete(v);
      return n;
    });
  return [selected, toggle, () => setSelected(new Set())] as const;
}

// ---- editors ----

function MultiEditor<T extends string>({
  options,
  initial,
  build,
  label,
  hint,
  searchable,
  onApply,
  onCancel,
  applyLabel,
  layout,
}: Omit<Common, 'filters'> & {
  options: readonly T[];
  initial: readonly T[] | undefined;
  build: (values: T[] | undefined) => Filters;
  label?: (v: T) => string;
  hint?: (v: T) => string | undefined;
  searchable?: boolean;
}) {
  const [selected, toggle, clear] = useSelection(initial);
  return layout({
    body: <OptionList options={options} selected={selected} onToggle={toggle} label={label} hint={hint} searchable={searchable} />,
    footer: (
      <Footer
        onCancel={onCancel}
        applyLabel={applyLabel}
        onClear={selected.size > 0 ? clear : undefined}
        onApply={() => onApply(build(options.filter((o) => selected.has(o))))}
      />
    ),
  });
}

function LocationEditor({ filters, onApply, onCancel, applyLabel, layout }: Common) {
  const [cities, toggleCity, clearCities] = useSelection<City>(filters.cities);
  const [states, toggleState, clearStates] = useSelection<State>(filters.states);
  return layout({
    body: (
      <div className="space-y-4">
        <OptionList heading="Cities" options={CITIES} selected={cities} onToggle={toggleCity} hint={(c) => CITY_STATE[c]} />
        <OptionList heading="Whole states" options={STATES} selected={states} onToggle={toggleState} label={(s) => STATE_NAMES[s]} hint={(s) => s} />
      </div>
    ),
    footer: (
      <Footer
        onCancel={onCancel}
        applyLabel={applyLabel}
        onClear={cities.size + states.size > 0 ? () => (clearCities(), clearStates()) : undefined}
        onApply={() => onApply(normalizeFilters({ ...filters, cities: CITIES.filter((c) => cities.has(c)), states: STATES.filter((s) => states.has(s)) }))}
      />
    ),
  });
}

function ExcludeEditor({ filters, excludeKey, onApply, onCancel, applyLabel, layout }: Common & { excludeKey: ExcludeKey }) {
  const options: readonly string[] = { roles: ROLES, cities: CITIES, states: STATES, skills: SKILLS, schools: SCHOOLS, degrees: DEGREES, employers: EMPLOYERS }[excludeKey];
  const [selected, toggle, clear] = useSelection<string>(filters.exclude?.[excludeKey]);
  return layout({
    body: <OptionList options={options} selected={selected} onToggle={toggle} searchable={options.length > 15} label={excludeKey === 'states' ? (s) => STATE_NAMES[s as State] : undefined} />,
    footer: (
      <Footer
        onCancel={onCancel}
        applyLabel={applyLabel}
        onClear={selected.size > 0 ? clear : undefined}
        onApply={() => onApply(normalizeFilters({ ...filters, exclude: { ...filters.exclude, [excludeKey]: options.filter((o) => selected.has(o)) } }))}
      />
    ),
  });
}

const selectClass =
  'h-11 w-full rounded-lg bg-white px-3 text-base ring-1 ring-stone-300 ring-inset outline-none focus:ring-2 focus:ring-indigo-600 sm:h-10 sm:text-sm';

function RangeEditor({
  unit,
  min,
  max,
  initial,
  build,
  onApply,
  onCancel,
  applyLabel,
  layout,
}: Omit<Common, 'filters'> & { unit: 'years' | 'year'; min: number; max: number; initial: [number | undefined, number | undefined]; build: (r: [number | undefined, number | undefined]) => Filters }) {
  const [from, setFrom] = useState(initial[0]);
  const [to, setTo] = useState(initial[1]);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  const pick = (v: string) => (v === '' ? undefined : Number(v));
  const select = (which: 'from' | 'to', value: number | undefined, onChange: (v: number | undefined) => void) => (
    <div className="min-w-0 flex-1">
      <label htmlFor={`${id}-${which}`} className="text-sm font-medium">
        {which === 'from' ? (unit === 'years' ? 'At least' : 'From') : unit === 'years' ? 'At most' : 'To'}
      </label>
      <select id={`${id}-${which}`} value={value ?? ''} onChange={(e) => onChange(pick(e.target.value))} className={cn(selectClass, 'mt-1.5')}>
        <option value="">Any</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {unit === 'years' ? `${v} ${v === 1 ? 'year' : 'years'}` : v}
          </option>
        ))}
      </select>
    </div>
  );
  return layout({
    body: (
      <div className="flex gap-3">
        {select('from', from, setFrom)}
        {select('to', to, setTo)}
      </div>
    ),
    footer: (
      <Footer
        onCancel={onCancel}
        applyLabel={applyLabel}
        error={error}
        onClear={from !== undefined || to !== undefined ? () => (setFrom(undefined), setTo(undefined)) : undefined}
        onApply={() => {
          if (from !== undefined && to !== undefined && from > to) return setError(`“${unit === 'years' ? 'At least' : 'From'}” can’t be more than “${unit === 'years' ? 'At most' : 'To'}”.`);
          onApply(build([from, to]));
        }}
      />
    ),
  });
}

function Choice<T extends string>({ name, options, value, onChange, label }: { name: string; options: readonly T[]; value: T; onChange: (v: T) => void; label: (v: T) => string }) {
  return (
    <div className="grid gap-1.5" role="radiogroup">
      {options.map((o) => (
        <label
          key={o}
          className={cn(
            'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm ring-1 ring-inset sm:min-h-10',
            value === o ? 'bg-indigo-50 font-medium text-indigo-900 ring-indigo-300' : 'ring-stone-200 hover:bg-stone-50',
          )}
        >
          <input type="radio" name={name} value={o} checked={value === o} onChange={() => onChange(o)} className="size-4 accent-indigo-600" />
          {label(o)}
        </label>
      ))}
    </div>
  );
}

function OpenToWorkEditor({ filters, onApply, onCancel, applyLabel, layout }: Common) {
  const [value, setValue] = useState<'yes' | 'no'>(filters.open_to_work === false ? 'no' : 'yes');
  const name = useId();
  return layout({
    body: <Choice name={name} options={['yes', 'no'] as const} value={value} onChange={setValue} label={(v) => (v === 'yes' ? 'Open to work' : 'Not open to work')} />,
    footer: <Footer onCancel={onCancel} applyLabel={applyLabel} onApply={() => onApply(normalizeFilters({ ...filters, open_to_work: value === 'yes' }))} />,
  });
}

const WHEN_HINTS: Record<ExperienceCondition['when'], string> = {
  any: 'Worked at (any job)',
  current: 'Currently at (current job)',
  past: 'Formerly at (not now)',
  never: 'Never at',
};

function ExperienceEditor({ filters, index, onApply, onCancel, applyLabel, layout }: Common & { index: number | null }) {
  const existing = index === null ? undefined : filters.experience?.[index];
  const [when, setWhen] = useState<ExperienceCondition['when']>(existing?.when ?? 'any');
  const [type, setType] = useState<CompanyType | 'any'>(existing?.company_type ?? 'any');
  const [employers, toggle] = useSelection<Employer>(existing?.employers);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const apply = () => {
    if (type === 'any' && employers.size === 0) return setError('Pick a company type or at least one employer.');
    const condition: ExperienceCondition = { when, ...(type !== 'any' && { company_type: type }), ...(employers.size > 0 && { employers: EMPLOYERS.filter((e) => employers.has(e)) }) };
    const list = [...(filters.experience ?? [])];
    if (index === null) list.push(condition);
    else list[index] = condition;
    onApply(normalizeFilters({ ...filters, experience: list }));
  };

  return layout({
    body: (
      <div className="space-y-5">
        <fieldset>
          <legend className="mb-1.5 text-xs font-semibold tracking-wide text-stone-500 uppercase">When</legend>
          <Choice name={`${id}-when`} options={EXPERIENCE_WHEN} value={when} onChange={setWhen} label={(w) => WHEN_HINTS[w]} />
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-xs font-semibold tracking-wide text-stone-500 uppercase">Company type</legend>
          <Choice
            name={`${id}-type`}
            options={['any', 'startup', 'enterprise'] as const}
            value={type}
            onChange={setType}
            label={(t) => (t === 'any' ? 'Any type' : t === 'startup' ? 'Startup' : 'Enterprise')}
          />
        </fieldset>
        <OptionList heading="Employers" options={EMPLOYERS} selected={employers} onToggle={toggle} hint={(e) => EMPLOYER_TYPE[e]} searchable />
      </div>
    ),
    footer: <Footer onCancel={onCancel} applyLabel={applyLabel} error={error} onApply={apply} />,
  });
}

