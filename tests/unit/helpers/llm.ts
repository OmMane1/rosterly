import type { LlmFilters } from '@/lib/server/search/llm-schema';

/** A complete model answer with no constraints, to be overridden per test. */
export function emptyLlm(overrides: Partial<LlmFilters> = {}): LlmFilters {
  return {
    unsupported: [],
    ignored: [],
    roles: [],
    seniority: [],
    cities: [],
    states: [],
    skills_all: [],
    skills_any: [],
    open_to_work: 'any',
    years_min: 0,
    years_max: 99,
    experience: [],
    schools: [],
    degrees: [],
    fields: [],
    graduated_min: 0,
    graduated_max: 9999,
    exclude: { roles: [], cities: [], states: [], skills: [], schools: [], degrees: [], employers: [] },
    ...overrides,
  };
}
