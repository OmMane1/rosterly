import { describe, expect, it } from 'vitest';
import { findMentions, LEXICON, LEXICON_VOCABULARY, mentionedValues, type LexiconCategory } from '@/lib/shared/lexicon';

const CATEGORIES = Object.keys(LEXICON) as LexiconCategory[];
const mentions = (text: string) => findMentions(text).map((m) => `${m.category}:${m.value}`);

describe('lexicon data', () => {
  it('covers every vocabulary value, and nothing else', () => {
    for (const category of CATEGORIES) {
      expect(Object.keys(LEXICON[category]).sort(), category).toEqual([...LEXICON_VOCABULARY[category]].sort());
      for (const [value, aliases] of Object.entries(LEXICON[category])) {
        expect(aliases.length, `${category}:${value}`).toBeGreaterThan(0);
        for (const alias of aliases) expect(alias, `${category}:${value}`).toBe(alias.trim());
      }
    }
  });

  it('never gives two values of one category the same alias', () => {
    for (const category of CATEGORIES) {
      const owner = new Map<string, string>();
      for (const [value, aliases] of Object.entries(LEXICON[category])) {
        for (const alias of aliases) {
          const key = alias.toLowerCase().replace(/[\s-]+/g, '');
          expect(owner.get(key) ?? value, `${category} alias "${alias}"`).toBe(value);
          owner.set(key, value);
        }
      }
    }
  });

  it('finds every value by its own name', () => {
    for (const category of CATEGORIES) {
      for (const value of LEXICON_VOCABULARY[category]) {
        expect(mentionedValues(`we want ${value} please`, category).has(value), `${category}:${value}`).toBe(true);
      }
    }
  });
});

describe('findMentions', () => {
  it('reads Go and R only as the capitalised whole word', () => {
    expect(mentionedValues('engineers in Chicago', 'skill')).toEqual(new Set());
    expect(mentionedValues('happy to go remote', 'skill')).toEqual(new Set());
    expect(mentionedValues('Go and Rust backend engineers', 'skill')).toEqual(new Set(['Go', 'Rust']));
    expect(mentionedValues('golang developers', 'skill')).toEqual(new Set(['Go']));
    expect(mentionedValues('data scientists who know R and Python', 'skill')).toEqual(new Set(['R', 'Python']));
    expect(mentionedValues('a strong recruiter', 'skill')).toEqual(new Set());
  });

  it('keeps look-alike skills apart', () => {
    expect(mentionedValues('React Native developers', 'skill')).toEqual(new Set(['React Native']));
    expect(mentionedValues('React and React Native', 'skill')).toEqual(new Set(['React', 'React Native']));
    expect(mentionedValues('JavaScript engineers', 'skill')).toEqual(new Set(['JavaScript']));
    expect(mentionedValues('Java engineers', 'skill')).toEqual(new Set(['Java']));
    expect(mentionedValues('PostgreSQL experience', 'skill')).toEqual(new Set(['Postgres']));
    expect(mentionedValues('SQL and Postgres', 'skill')).toEqual(new Set(['SQL', 'Postgres']));
  });

  it('lets a role phrase claim its words', () => {
    expect(mentions('machine learning engineers')).toEqual(['role:Machine Learning Engineer']);
    expect(mentions('ML engineers')).toEqual(['role:Machine Learning Engineer']);
    expect(mentions('data scientists with machine learning')).toEqual(['role:Data Scientist', 'skill:Machine Learning']);
  });

  it('matches spacing and hyphen variants, and plurals', () => {
    for (const text of ['front-end engineers', 'frontend engineer', 'front end developers']) {
      expect(mentionedValues(text, 'role'), text).toEqual(new Set(['Frontend Engineer']));
    }
    expect(mentionedValues('full-stack devs', 'role')).toEqual(new Set(['Full Stack Engineer']));
    expect(mentionedValues('experience with LLMs', 'skill')).toEqual(new Set(['LLMs']));
    expect(mentionedValues('K8s and CI/CD', 'skill')).toEqual(new Set(['Kubernetes', 'CI/CD']));
  });

  it('reads place names, abbreviations and nested names correctly', () => {
    expect(mentionedValues('engineers in the Bay Area or SF', 'city')).toEqual(new Set(['San Francisco']));
    expect(mentionedValues('designers in LA', 'city')).toEqual(new Set(['Los Angeles']));
    expect(mentionedValues('la la land', 'city')).toEqual(new Set());
    expect(mentions('NYU grads')).toEqual(['school:New York University']);
    expect(mentions('NYU grads in New York')).toEqual(['school:New York University', 'city:New York', 'state:NY']);
    expect(mentions('University of Washington alumni')).toEqual(['school:University of Washington']);
    expect(mentions('Georgia Tech')).toEqual(['school:Georgia Tech']);
    expect(mentionedValues('anyone in Illinois', 'state')).toEqual(new Set(['IL']));
    expect(mentionedValues('anyone in Illinois', 'school')).toEqual(new Set(['University of Illinois']));
  });

  it('reads Washington DC as nothing, but Washington state as WA', () => {
    expect(mentions('engineers in Washington DC')).toEqual([]);
    expect(mentions('engineers in Washington, D.C.')).toEqual([]);
    expect(mentionedValues('engineers in Washington state', 'state')).toEqual(new Set(['WA']));
    expect(mentionedValues('Seattle, WA', 'state')).toEqual(new Set(['WA']));
    expect(mentionedValues('co-founders', 'state')).toEqual(new Set());
  });

  it('knows employers by full name and by an unambiguous first word', () => {
    expect(mentionedValues('ex-Halvorsen folks', 'employer')).toEqual(new Set(['Halvorsen Bank']));
    expect(mentionedValues('worked at Inkwell AI', 'employer')).toEqual(new Set(['Inkwell AI']));
    expect(mentionedValues('currently at Fizzbit', 'employer')).toEqual(new Set(['Fizzbit']));
  });

  it('never matches inside a word, in any script', () => {
    expect(findMentions('Gosling Rustacean Javanese Reactor Typescripted')).toEqual([]);
    expect(findMentions('ÉGo Ŕ 東京Go')).toEqual([]);
  });

  it('returns positions that point at the matched text', () => {
    const text = 'senior Golang engineers in NYC';
    for (const m of findMentions(text)) {
      expect(text.slice(m.start, m.end).length).toBeGreaterThan(0);
    }
    expect(findMentions(text).map((m) => text.slice(m.start, m.end))).toEqual(['Golang', 'NYC']);
  });
});

// findMentions skips an alias's regex when the alias's first word isn't in the brief. These pin
// down why that skip can never hide a real mention.
describe('the substring screen in findMentions', () => {
  it('rests on two facts: every alias is ASCII, and /iu folds only ſ and K (Kelvin) onto ASCII', () => {
    for (const category of CATEGORIES) {
      for (const aliases of Object.values(LEXICON[category])) for (const alias of aliases) expect(alias, category).toMatch(/^[\x20-\x7e]+$/);
    }
    const folding: string[] = [];
    for (let cp = 0x80; cp < 0x110000; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (/^[a-z0-9]$/iu.test(String.fromCodePoint(cp))) folding.push(cp.toString(16));
    }
    expect(folding).toEqual(['17f', '212a']);
  });

  it('finds every case-insensitive alias in upper case, title case and spelt with ſ and K', () => {
    for (const category of CATEGORIES) {
      for (const [value, aliases] of Object.entries(LEXICON[category])) {
        for (const alias of aliases.filter((a) => a === a.toLowerCase())) {
          const variants = [alias.toUpperCase(), alias.replace(/\b\w/g, (c) => c.toUpperCase()), alias.replaceAll('s', 'ſ').replaceAll('k', 'K')];
          for (const variant of variants) {
            expect(mentionedValues(`we want ${variant} please`, category).has(value), `${category}:${value} as “${variant}”`).toBe(true);
          }
        }
      }
    }
  });
});
