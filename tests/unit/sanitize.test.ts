import { describe, expect, it } from 'vitest';
import { Brief, MAX_BRIEF_LENGTH } from '@/lib/shared/brief';
import { sanitizeDeep, sanitizeText } from '@/lib/shared/sanitize';

describe('sanitizeText', () => {
  it('strips NUL, C0 (except \\n and \\t), DEL and C1 controls', () => {
    expect(sanitizeText('a\u0000b\u0007c\rd\u001Fe\u007Ff\u0085g\u009Fh')).toBe('abcdefgh');
    expect(sanitizeText('line one\nline\ttwo')).toBe('line one\nline\ttwo');
  });

  it('replaces lone surrogates and keeps real pairs', () => {
    expect(sanitizeText('x\uD800y\uDFFFz')).toBe('x�y�z');
    expect(sanitizeText('rocket 🚀')).toBe('rocket 🚀');
  });

  it('normalises to NFC', () => {
    expect(sanitizeText('José')).toBe('José');
    expect(sanitizeText('José')).toHaveLength(4);
  });

  it('leaves ordinary text alone', () => {
    const text = 'senior React engineers in New York — "ex-Corvane", 5+ years; <b>bold</b> & 100%';
    expect(sanitizeText(text)).toBe(text);
  });
});

describe('sanitizeDeep', () => {
  it('cleans every string in nested objects and arrays, keys included', () => {
    const dirty = { 'ro\u0000les': ['Back\u0007end Engineer'], nested: { ignored: ['ninja\uD800'], n: 3, ok: true, none: null } };
    expect(sanitizeDeep(dirty)).toEqual({ roles: ['Backend Engineer'], nested: { ignored: ['ninja�'], n: 3, ok: true, none: null } });
  });

  it('passes non-strings through', () => {
    expect(sanitizeDeep(42)).toBe(42);
    expect(sanitizeDeep(null)).toBe(null);
    expect(sanitizeDeep([false, 1.5])).toEqual([false, 1.5]);
  });
});

describe('Brief', () => {
  it('sanitises and trims', () => {
    expect(Brief.parse('  data scientists\u0000 with a PhD \n')).toBe('data scientists with a PhD');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '  \n\t '],
    ['control characters only', '\u0000\u0001\u007F'],
    ['over the limit', 'x'.repeat(MAX_BRIEF_LENGTH + 1)],
    ['10 KB', 'backend engineers '.repeat(600)],
  ])('rejects %s', (_, value) => {
    expect(Brief.safeParse(value).success).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const value of [undefined, null, 42, ['brief'], { brief: 'x' }]) expect(Brief.safeParse(value).success).toBe(false);
  });

  it('counts code points like Postgres char_length, not UTF-16 units', () => {
    const emoji = '🚀'.repeat(MAX_BRIEF_LENGTH);
    expect(emoji.length).toBe(2 * MAX_BRIEF_LENGTH);
    expect(Brief.safeParse(emoji).success).toBe(true);
    expect(Brief.safeParse(`${emoji}x`).success).toBe(false);
  });

  it('accepts exactly the limit', () => {
    expect(Brief.safeParse('x'.repeat(MAX_BRIEF_LENGTH)).success).toBe(true);
  });
});
