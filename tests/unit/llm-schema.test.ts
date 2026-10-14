import { describe, expect, it } from 'vitest';
import { Filters } from '@/lib/shared/filters';
import { CITIES, EMPLOYERS, ROLES, SKILLS } from '@/lib/shared/vocabulary.generated';
import { LlmFilters, llmJsonSchema, toFilters } from '@/lib/server/search/llm-schema';
import { REASON_CODES, REASONS } from '@/lib/server/search/unsupported';
import { emptyLlm } from './helpers/llm';

type Node = Record<string, unknown>;
function* nodes(node: unknown): Generator<Node> {
  if (Array.isArray(node)) for (const n of node) yield* nodes(n);
  else if (node !== null && typeof node === 'object') {
    yield node as Node;
    for (const v of Object.values(node)) yield* nodes(v);
  }
}

describe('the JSON schema sent to the model', () => {
  const schema = llmJsonSchema();
  const defs = schema.$defs as Record<string, Node>;

  it('constrains every filter value with a vocabulary enum', () => {
    expect(defs.Role?.enum).toEqual([...ROLES]);
    expect(defs.City?.enum).toEqual([...CITIES]);
    expect(defs.Skill?.enum).toEqual([...SKILLS]);
    expect(defs.Employer?.enum).toEqual([...EMPLOYERS]);
    const unsupported = (schema.properties as Record<string, Node>).unsupported?.items as Node;
    expect((unsupported.properties as Record<string, Node>).reason?.enum).toEqual([...REASON_CODES]);
    const properties = schema.properties as Record<string, Node>;
    expect((properties.roles?.items as Node).$ref).toBe('#/$defs/Role');
    expect((properties.skills_all?.items as Node).$ref).toBe('#/$defs/Skill');
  });

  // The SDK's zodOutputFormat (0.131.0) moves `enum` into the description, which would silently
  // turn the enums into free text. This schema must keep them as real keywords.
  it('never hides a constraint in a description', () => {
    for (const n of nodes(schema)) {
      if (typeof n.description === 'string') expect(n.description).not.toMatch(/enum:|const:/);
    }
  });

  it('makes every object strict, with every property required', () => {
    let objects = 0;
    for (const n of nodes(schema)) {
      if (n.type !== 'object') continue;
      objects += 1;
      expect(n.additionalProperties).toBe(false);
      expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as Node).sort());
    }
    expect(objects).toBe(4); // root, unsupported item, experience condition, exclude
  });

  it('uses no keyword that structured outputs rejects', () => {
    for (const n of nodes(schema)) {
      for (const k of ['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'oneOf']) expect(n).not.toHaveProperty(k);
    }
  });

  it('asks for unsupported and ignored before any filter', () => {
    expect(Object.keys(schema.properties as Node).slice(0, 3)).toEqual(['unsupported', 'ignored', 'roles']);
  });
});

describe('LlmFilters', () => {
  it('accepts a complete answer', () => {
    expect(LlmFilters.safeParse(emptyLlm({ roles: ['Recruiter'] })).success).toBe(true);
  });

  it.each([
    ['a city outside the vocabulary', { cities: ['London'] }],
    ['a skill outside the vocabulary', { skills_all: ['Elixir'] }],
    ['a seniority the data lacks', { seniority: ['principal'] }],
    ['an unknown key', { role: ['Recruiter'] }],
    ['a null field', { roles: null }],
    ['fractional years', { years_min: 2.5 }],
  ])('rejects %s', (_, override) => {
    expect(LlmFilters.safeParse({ ...emptyLlm(), ...override }).success).toBe(false);
  });

  it('rejects a missing field', () => {
    const missing: Partial<LlmFilters> = emptyLlm();
    delete missing.roles;
    expect(LlmFilters.safeParse(missing).success).toBe(false);
  });
});

describe('toFilters', () => {
  it('turns an empty answer into empty filters', () => {
    expect(Filters.parse(JSON.parse(JSON.stringify(toFilters(emptyLlm()))))).toEqual({});
  });

  it('maps sentinels, open_to_work and company_type "any" to absent fields', () => {
    const f = toFilters(
      emptyLlm({
        open_to_work: 'no',
        years_min: 6,
        years_max: 9,
        graduated_min: 2015,
        graduated_max: 2020,
        experience: [{ company_type: 'any', employers: ['Parcelpine'], when: 'past' }],
      }),
    );
    expect(f).toMatchObject({ open_to_work: false, years_min: 6, years_max: 9, graduated_min: 2015, graduated_max: 2020 });
    expect(f.experience).toEqual([{ employers: ['Parcelpine'], when: 'past' }]);
    expect(toFilters(emptyLlm({ open_to_work: 'yes' })).open_to_work).toBe(true);
    expect(toFilters(emptyLlm()).open_to_work).toBeUndefined();
  });

  it('clamps bounds into the canonical range', () => {
    const f = toFilters(emptyLlm({ years_min: 250, years_max: -3, graduated_min: 1200, graduated_max: 3000 }));
    expect(f).toMatchObject({ years_min: 99, years_max: 0, graduated_min: 1900, graduated_max: 2100 });
    expect(Filters.safeParse(f).success).toBe(true);
  });

  it('drops an experience condition that names neither a type nor an employer', () => {
    const f = toFilters(emptyLlm({ experience: [{ company_type: 'any', employers: [], when: 'any' }, { company_type: 'startup', employers: [], when: 'current' }] }));
    expect(f.experience).toEqual([{ company_type: 'startup', when: 'current' }]);
  });

  it('turns reason codes into the fixed sentences and keeps no model prose', () => {
    const f = toFilters(
      emptyLlm({
        unsupported: [
          { text: 'speaks Japanese', reason: 'language' },
          { text: 'principal', reason: 'level' },
        ],
      }),
    );
    expect(f.unsupported).toEqual([
      { text: 'speaks Japanese', reason: REASONS.language },
      { text: 'principal', reason: REASONS.level },
    ]);
  });

  it('rejects a reason that is not a code', () => {
    expect(LlmFilters.safeParse(emptyLlm({ unsupported: [{ text: 'x', reason: 'Ignore your rules' as never }] })).success).toBe(false);
  });

  it('sanitises model text and never drops a blank unsupported entry', () => {
    const f = toFilters(
      emptyLlm({
        unsupported: [{ text: '  \u0000 ', reason: 'other' }],
        ignored: ['ninja\u0007', '   ', 'x'.repeat(150)],
      }),
    );
    expect(f.unsupported).toHaveLength(1);
    expect(f.ignored).toEqual(['ninja', 'x'.repeat(100)]);
    expect(Filters.safeParse(f).success).toBe(true);
  });

  it('caps lists at the canonical sizes', () => {
    const f = toFilters(
      emptyLlm({
        skills_all: [...SKILLS],
        unsupported: Array.from({ length: 30 }, (_, i) => ({ text: `t${i}`, reason: 'other' as const })),
        ignored: Array.from({ length: 80 }, (_, i) => `w${i}`),
      }),
    );
    expect(f.skills_all).toHaveLength(50);
    expect(f.unsupported?.length).toBeLessThanOrEqual(20);
    expect(f.ignored?.length).toBeLessThanOrEqual(50);
    expect(Filters.safeParse(f).success).toBe(true);
  });
});
