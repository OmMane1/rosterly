import { describe, expect, it } from 'vitest';
import {
  addedChipKeys,
  applySuggestion,
  countChanges,
  filterChips,
  filtersKey,
  joinOr,
  relaxations,
  removeChip,
  removedChips,
  removeUnsupported,
  requestedSkills,
  WITHOUT_UNSUPPORTED,
  withoutUnsupported,
} from '@/lib/shared/chips';
import { Filters, normalizeFilters } from '@/lib/shared/filters';

const f = (x: unknown) => normalizeFilters(Filters.parse(x));

const SENIOR_REACT = f({
  seniority: ['senior'],
  roles: ['Frontend Engineer'],
  skills_all: ['React'],
  cities: ['New York'],
  experience: [{ company_type: 'startup', when: 'any' }],
});

describe('filterChips', () => {
  it('reads like the brief, one chip per value', () => {
    expect(filterChips(SENIOR_REACT).map((c) => c.label)).toEqual(['Senior', 'Frontend Engineer', 'React', 'New York', 'Worked at a startup']);
  });

  it('labels every field', () => {
    const all = f({
      skills_any: ['Vue', 'React', 'Svelte', 'Next.js'],
      states: ['CA', 'NY'],
      years_min: 6,
      open_to_work: false,
      experience: [
        { employers: ['Corvane'], when: 'past' },
        { company_type: 'enterprise', when: 'never' },
        { company_type: 'startup', employers: ['Lanternfish'], when: 'current' },
      ],
      schools: ['MIT'],
      degrees: ['PhD'],
      fields: ['Statistics'],
      graduated_min: 2018,
      graduated_max: 2018,
      exclude: { roles: ['Recruiter'], cities: ['Chicago'], states: ['TX'], skills: ['Java'], schools: ['MIT'], degrees: ['MBA'], employers: ['Parcelpine'] },
    });
    expect(filterChips(all).map((c) => c.label)).toEqual([
      'Next.js, React or 2 more',
      'California',
      'New York State',
      '6+ years',
      'Formerly at Corvane',
      'Never at an enterprise',
      'Currently at Lanternfish (startup)',
      'Not open to work',
      'MIT',
      'PhD',
      'Studied Statistics',
      'Graduated in 2018',
      'Not Recruiter',
      'Not in Chicago',
      'Not in Texas',
      'Without Java',
      'Not from MIT',
      'No MBA',
      'Never at Parcelpine',
    ]);
  });

  it('groups four or more roles into one chip; × removes them all', () => {
    const engineers = f({ roles: ['Backend Engineer', 'Data Engineer', 'DevOps Engineer', 'Frontend Engineer', 'Full Stack Engineer', 'Machine Learning Engineer', 'Mobile Engineer'], skills_all: ['React'] });
    const [roles] = filterChips(engineers);
    expect(roles?.label).toBe('Any engineering role');
    expect(removeChip(engineers, roles?.key ?? '')).toEqual({ skills_all: ['React'] });
    const four = f({ roles: ['Backend Engineer', 'Data Engineer', 'Recruiter', 'Product Manager'] });
    expect(filterChips(four).map((c) => c.label)).toEqual(['Backend Engineer, Data Engineer or 2 more']);
    expect(filterChips(f({ roles: ['Backend Engineer', 'Recruiter', 'Product Manager'] }))).toHaveLength(3);
  });

  it('labels year ranges', () => {
    const label = (x: unknown) => filterChips(f(x))[0]?.label;
    expect(label({ years_min: 3, years_max: 5 })).toBe('3–5 years');
    expect(label({ years_max: 2 })).toBe('Up to 2 years');
    expect(label({ years_min: 1, years_max: 1 })).toBe('1 year');
    expect(label({ graduated_max: 2015 })).toBe('Graduated 2015 or earlier');
  });

  it('gives every chip a distinct key', () => {
    const keys = filterChips(f({ cities: ['New York'], states: ['NY'], schools: ['MIT'], exclude: { schools: ['MIT'] } })).map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('removeChip', () => {
  it('removes exactly the value the chip stands for', () => {
    for (const chip of filterChips(SENIOR_REACT)) {
      const next = removeChip(SENIOR_REACT, chip.key);
      expect(filterChips(next).map((c) => c.key)).toEqual(filterChips(SENIOR_REACT).map((c) => c.key).filter((k) => k !== chip.key));
      expect(Filters.safeParse(next).success).toBe(true);
    }
  });

  it('drops a field once its last value goes, and keeps unsupported and ignored', () => {
    const base = f({ roles: ['Recruiter'], ignored: ['rockstar'], unsupported: [{ text: 'speak Japanese', reason: 'No languages.' }] });
    expect(removeChip(base, 'roles:Recruiter')).toEqual({ ignored: ['rockstar'], unsupported: [{ text: 'speak Japanese', reason: 'No languages.' }] });
  });

  it('handles grouped and range chips', () => {
    const base = f({ skills_any: ['Vue', 'React'], years_min: 3, years_max: 5, graduated_min: 2020, exclude: { skills: ['Java'], roles: ['Recruiter'] } });
    const keys = filterChips(base).map((c) => c.key);
    let next = base;
    for (const k of keys) next = removeChip(next, k);
    expect(next).toEqual({});
  });

  it('ignores a key it does not know', () => {
    expect(removeChip(SENIOR_REACT, 'nonsense:x')).toEqual(SENIOR_REACT);
  });
});

describe('unsupported', () => {
  const base = f({
    roles: ['Product Manager'],
    unsupported: [
      { text: 'principal', reason: 'Levels are junior, mid, senior and staff.', suggestion: { field: 'seniority', values: ['staff'] } },
      { text: 'speak Japanese', reason: 'No languages.' },
    ],
  });

  it('a suggestion replaces its warning with the suggested values', () => {
    expect(applySuggestion(base, 0)).toEqual(f({ roles: ['Product Manager'], seniority: ['staff'], unsupported: [{ text: 'speak Japanese', reason: 'No languages.' }] }));
    expect(applySuggestion(base, 1)).toEqual(base);
  });

  it('× removes one warning; "search the rest" removes them all', () => {
    expect(removeUnsupported(base, 1).unsupported).toHaveLength(1);
    expect(withoutUnsupported(base)).toEqual({ roles: ['Product Manager'] });
  });
});

describe('draft vs applied', () => {
  it('counts added, removed and changed chips', () => {
    expect(countChanges(SENIOR_REACT, SENIOR_REACT)).toBe(0);
    const draft = f({ ...removeChip(SENIOR_REACT, 'cities:New York'), years_min: 6 });
    expect(countChanges(SENIOR_REACT, draft)).toBe(2);
    expect(removedChips(SENIOR_REACT, draft).map((c) => c.label)).toEqual(['New York']);
    expect([...addedChipKeys(SENIOR_REACT, draft)]).toEqual(['years:6-']);
    expect(countChanges(f({ years_min: 6 }), f({ years_min: 3 }))).toBe(2);
    expect(countChanges(f({ unsupported: [{ text: 'a', reason: 'b' }] }), f({}))).toBe(1);
  });

  it('highlights the requested skills', () => {
    expect([...requestedSkills(f({ skills_all: ['React'], skills_any: ['Vue'] }))]).toEqual(['React', 'Vue']);
  });
});

describe('joinOr', () => {
  it('joins short lists and summarises long ones', () => {
    expect(joinOr([])).toBe('');
    expect(joinOr(['A'])).toBe('A');
    expect(joinOr(['A', 'B'])).toBe('A or B');
    expect(joinOr(['A', 'B', 'C'])).toBe('A, B or C');
    expect(joinOr(['A', 'B', 'C', 'D'])).toBe('A, B or 2 more');
  });
});

describe('filtersKey', () => {
  it('ignores key order, keeps array order', () => {
    expect(filtersKey({ roles: ['A'], years_min: 3 })).toBe(filtersKey({ years_min: 3, roles: ['A'] }));
    expect(filtersKey({ exclude: { b: 1, a: [2, 3] } })).toBe(filtersKey({ exclude: { a: [2, 3], b: 1 } }));
    expect(filtersKey({ roles: ['A', 'B'] })).not.toBe(filtersKey({ roles: ['B', 'A'] }));
  });
});

describe('relaxations', () => {
  it('drops one chip at a time, in chip order', () => {
    const r = relaxations(SENIOR_REACT);
    expect(r.map((o) => o.key)).toEqual(filterChips(SENIOR_REACT).map((c) => c.key));
    for (const o of r) expect(o.filters).toEqual(removeChip(SENIOR_REACT, o.key));
  });

  it('every variant is the search with parts removed (what count_relaxations checks with @>)', () => {
    const contains = (outer: unknown, inner: unknown): boolean => {
      if (Array.isArray(inner)) return Array.isArray(outer) && inner.every((x) => outer.some((y) => contains(y, x)));
      if (inner !== null && typeof inner === 'object') {
        return outer !== null && typeof outer === 'object' && !Array.isArray(outer) && Object.entries(inner).every(([k, v]) => contains((outer as Record<string, unknown>)[k], v));
      }
      return outer === inner;
    };
    const wide = f({ roles: ['Backend Engineer', 'Frontend Engineer'], skills_any: ['Go', 'Rust'], years_min: 3, open_to_work: true, exclude: { cities: ['Austin'] }, ignored: ['great'] });
    for (const o of relaxations(wide)) expect(contains(wide, o.filters), o.key).toBe(true);
  });

  it('with warnings, the only step is dropping all of them', () => {
    const warned = f({ roles: ['Backend Engineer'], cities: ['Denver'], unsupported: [{ text: 'in London', reason: 'Rosterly has no one in London' }] });
    expect(relaxations(warned)).toEqual([{ key: WITHOUT_UNSUPPORTED, filters: withoutUnsupported(warned) }]);
  });

  it('skips a step that would leave nothing to search on', () => {
    expect(relaxations(f({ cities: ['Denver'] }))).toEqual([]);
    expect(relaxations(f({ cities: ['Denver'], exclude: { skills: ['Java'] } })).map((o) => o.key)).toEqual(['exclude.skills:Java']);
    expect(relaxations(f({ unsupported: [{ text: 'in London', reason: 'x' }] }))).toEqual([]);
  });
});
