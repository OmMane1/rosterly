import { describe, expect, it } from 'vitest';
import { Filters, hasSubstantiveFilter, isUnanswerable, MAX_FILTERS_BYTES, normalizeFilters } from '@/lib/shared/filters';

describe('Filters schema', () => {
  it('accepts every field with vocabulary values', () => {
    const full = {
      roles: ['Backend Engineer'],
      seniority: ['senior'],
      cities: ['Austin'],
      states: ['TX'],
      skills_all: ['Go'],
      skills_any: ['Kubernetes', 'Postgres'],
      open_to_work: true,
      years_min: 6,
      years_max: 9,
      experience: [{ company_type: 'startup', when: 'past' }, { employers: ['Corvane'], when: 'never' }],
      schools: ['MIT'],
      degrees: ['MS'],
      fields: ['Computer Science'],
      graduated_min: 2012,
      graduated_max: 2020,
      exclude: { roles: ['Recruiter'], cities: ['Miami'], states: ['FL'], skills: ['Java'], schools: ['Cornell University'], degrees: ['MBA'], employers: ['Parcelpine'] },
      unsupported: [{ text: 'principal', reason: 'No principal level in the data.', suggestion: { field: 'seniority', values: ['staff'] } }],
      ignored: ['rockstar'],
    };
    expect(Filters.safeParse(full).success).toBe(true);
  });

  it.each([
    ['an unknown key', { role: ['Backend Engineer'] }],
    ['a value outside the vocabulary', { cities: ['London'] }],
    ['a lowercase role', { roles: ['backend engineer'] }],
    ['a seniority the data lacks', { seniority: ['principal'] }],
    ['an unknown key inside exclude', { exclude: { titles: ['x'] } }],
    ['an experience condition with nothing to match', { experience: [{ when: 'any' }] }],
    ['a suggestion value outside its field', { unsupported: [{ text: 'x', reason: 'y', suggestion: { field: 'seniority', values: ['lead'] } }] }],
    ['an empty suggestion', { unsupported: [{ text: 'x', reason: 'y', suggestion: { field: 'roles', values: [] } }] }],
    ['fractional years', { years_min: 2.5 }],
    ['more than 50 values', { skills_any: Array.from({ length: 51 }, () => 'Go') }],
  ])('rejects %s', (_, value) => {
    expect(Filters.safeParse(value).success).toBe(false);
  });

  it('rejects filters over 16 KB as JSON', () => {
    const ignored = Array.from({ length: 50 }, (_, i) => `${'x'.repeat(95)}${i}`);
    const unsupported = Array.from({ length: 20 }, (_, i) => ({ text: `t${i}`.padEnd(200, 't'), reason: 'r'.repeat(300) }));
    const skills_any = Array.from({ length: 50 }, () => 'Pipeline Management');
    const big = { roles: ['Recruiter'], skills_any, ignored, unsupported };
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_FILTERS_BYTES);
    expect(Filters.safeParse(big).success).toBe(false);
  });
});

describe('hasSubstantiveFilter', () => {
  it.each([
    [{ roles: ['Recruiter'] }, true],
    [{ open_to_work: false }, true],
    [{ years_min: 3 }, true],
    [{ graduated_max: 2015 }, true],
    [{ experience: [{ company_type: 'startup', when: 'any' }] }, true],
    [{}, false],
    [{ roles: [], skills_all: [] }, false],
    [{ exclude: { roles: ['Recruiter'] } }, false],
    [{ ignored: ['ninja'] }, false],
    [{ unsupported: [{ text: 'Japanese', reason: 'no languages' }] }, false],
  ] as const)('%j → %s', (filters, expected) => {
    expect(hasSubstantiveFilter(Filters.parse(filters))).toBe(expected);
  });

  it('isUnanswerable only when something is unsupported', () => {
    expect(isUnanswerable({ roles: ['Recruiter'] })).toBe(false);
    expect(isUnanswerable({ roles: ['Recruiter'], unsupported: [{ text: 'Japanese', reason: 'no languages' }] })).toBe(true);
  });
});

describe('normalizeFilters', () => {
  it('dedupes and orders lists by the vocabulary, and drops empty ones', () => {
    const f = Filters.parse({
      roles: ['Recruiter', 'Backend Engineer', 'Recruiter'],
      seniority: ['staff', 'junior'],
      skills_all: [],
      exclude: { cities: [] },
      experience: [
        { employers: ['Parcelpine', 'Fizzbit'], when: 'any' },
        { employers: ['Fizzbit', 'Parcelpine'], when: 'any' },
      ],
      ignored: ['ninja', 'ninja'],
      unsupported: [],
    });
    expect(normalizeFilters(f)).toEqual({
      roles: ['Backend Engineer', 'Recruiter'],
      seniority: ['junior', 'staff'],
      experience: [{ employers: ['Fizzbit', 'Parcelpine'], when: 'any' }],
      ignored: ['ninja'],
    });
  });

  it('serialises equal filters identically, whatever the input order', () => {
    const a = normalizeFilters(Filters.parse({ cities: ['Boston', 'Austin'], open_to_work: true, roles: ['Data Scientist'] }));
    const b = normalizeFilters(Filters.parse({ roles: ['Data Scientist'], open_to_work: true, cities: ['Austin', 'Boston'] }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keeps scalar bounds, including false and 0', () => {
    expect(normalizeFilters({ open_to_work: false, years_min: 0, graduated_max: 2020 })).toEqual({ open_to_work: false, years_min: 0, graduated_max: 2020 });
  });
});
