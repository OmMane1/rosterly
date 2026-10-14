// Words a brief may use for each vocabulary value. The grounding check (M6) keeps a proper-noun
// filter value only if the brief mentions it, which catches enum-forced guesses such as
// London → "New York" (CLAUDE.md § Search rules, rule 5).
//
// Alias syntax:
//   - all-lowercase aliases match case-insensitively; an alias with a capital matches that exact case
//     ("Go", "R", "LA", state codes), so "go" and "Chicago" never mean the Go language;
//   - a space or hyphen in an alias matches any run of spaces/hyphens, or none ("front end" also
//     matches "front-end" and "frontend");
//   - matches are whole words, with an optional plural "s".
import {
  CITIES,
  EMPLOYERS,
  ROLES,
  SCHOOLS,
  SKILLS,
  STATES,
  type City,
  type Role,
  type School,
  type Skill,
  type State,
} from './vocabulary.generated';

export type LexiconCategory = 'city' | 'state' | 'employer' | 'school' | 'skill' | 'role';

const CITY_ALIASES: Record<City, readonly string[]> = {
  Atlanta: ['atlanta'],
  Austin: ['austin'],
  Boston: ['boston'],
  Chicago: ['chicago'],
  Denver: ['denver'],
  'Los Angeles': ['los angeles', 'LA', 'L.A.'],
  Miami: ['miami'],
  'New York': ['new york', 'new york city', 'nyc', 'manhattan', 'brooklyn'],
  'San Francisco': ['san francisco', 'sf', 'san fran', 'bay area'],
  Seattle: ['seattle'],
};

const STATE_ALIASES: Record<State, readonly string[]> = {
  CA: ['CA', 'california'],
  CO: ['CO', 'colorado'],
  FL: ['FL', 'florida'],
  GA: ['GA', 'georgia'],
  IL: ['IL', 'illinois'],
  MA: ['MA', 'massachusetts'],
  NY: ['NY', 'new york', 'new york state'],
  TX: ['TX', 'texas'],
  WA: ['WA', 'washington', 'washington state'],
};

const SCHOOL_ALIASES: Record<School, readonly string[]> = {
  'Carnegie Mellon University': ['carnegie mellon university', 'carnegie mellon', 'cmu'],
  'Columbia University': ['columbia university', 'columbia'],
  'Cornell University': ['cornell university', 'cornell'],
  'Georgia Tech': ['georgia tech', 'georgia institute of technology', 'gatech'],
  MIT: ['mit', 'massachusetts institute of technology'],
  'New York University': ['new york university', 'nyu'],
  'Northeastern University': ['northeastern university', 'northeastern'],
  'Stanford University': ['stanford university', 'stanford'],
  'UC Berkeley': ['uc berkeley', 'berkeley', 'university of california berkeley', 'university of california, berkeley'],
  'University of Illinois': ['university of illinois', 'uiuc', 'illinois'],
  'University of Michigan': ['university of michigan', 'umich', 'michigan'],
  'University of Texas at Austin': ['university of texas at austin', 'university of texas', 'ut austin', 'utexas'],
  'University of Washington': ['university of washington', 'uw'],
};

// Skills not listed here are matched by their own name.
const SKILL_ALIASES: Partial<Record<Skill, readonly string[]>> = {
  'A/B Testing': ['a/b testing', 'a/b test', 'ab testing', 'split testing'],
  Accessibility: ['accessibility', 'a11y', 'wcag'],
  Airflow: ['airflow', 'apache airflow'],
  AWS: ['aws', 'amazon web services'],
  Brand: ['brand', 'branding'],
  'CI/CD': ['ci/cd', 'cicd', 'ci cd', 'continuous integration', 'continuous delivery', 'continuous deployment'],
  CSS: ['css', 'css3'],
  'Design Systems': ['design system'],
  'Employer Branding': ['employer branding', 'employer brand'],
  GCP: ['gcp', 'google cloud', 'google cloud platform'],
  Go: ['Go', 'golang'],
  'Interaction Design': ['interaction design', 'ixd'],
  JavaScript: ['javascript', 'js'],
  Kubernetes: ['kubernetes', 'k8s'],
  'Lifecycle Marketing': ['lifecycle marketing', 'lifecycle'],
  LLMs: ['llm', 'large language model'],
  'Machine Learning': ['machine learning', 'ml'],
  MLOps: ['mlops', 'ml ops'],
  'Next.js': ['next.js', 'nextjs'],
  'Node.js': ['node.js', 'nodejs', 'node'],
  Outbound: ['outbound', 'outbound sales', 'outbound prospecting'],
  'Pipeline Management': ['pipeline management', 'pipeline'],
  Postgres: ['postgres', 'postgresql', 'psql'],
  Prototyping: ['prototyping', 'prototype'],
  R: ['R'],
  React: ['react', 'react.js', 'reactjs'],
  'React Native': ['react native'],
  Roadmapping: ['roadmapping', 'roadmap'],
  'Ruby on Rails': ['ruby on rails', 'rails', 'ror'],
  SEO: ['seo', 'search engine optimization'],
  Spark: ['spark', 'apache spark', 'pyspark'],
  Statistics: ['statistics', 'stats'],
  Svelte: ['svelte', 'sveltekit'],
  Tailwind: ['tailwind', 'tailwind css', 'tailwindcss'],
  'Technical Recruiting': ['technical recruiting', 'tech recruiting', 'technical recruitment'],
  TypeScript: ['typescript', 'ts'],
  'User Research': ['user research', 'ux research'],
  Vue: ['vue', 'vue.js', 'vuejs'],
};

// Roles are not grounded (only logged), but their phrases must claim their words: "machine
// learning engineers" names the role, not the Machine Learning skill.
const ROLE_ALIASES: Record<Role, readonly string[]> = {
  'Account Executive': ['account executive', 'AE'],
  'Backend Engineer': ['back end engineer', 'back end developer', 'back end'],
  'Data Engineer': ['data engineer', 'data engineering'],
  'Data Scientist': ['data scientist', 'data science'],
  'DevOps Engineer': ['dev ops engineer', 'dev ops'],
  'Frontend Engineer': ['front end engineer', 'front end developer', 'front end'],
  'Full Stack Engineer': ['full stack engineer', 'full stack developer', 'full stack'],
  'Machine Learning Engineer': ['machine learning engineer', 'ml engineer', 'MLE'],
  'Marketing Manager': ['marketing manager', 'marketer'],
  'Mobile Engineer': ['mobile engineer', 'mobile developer', 'mobile'],
  'Product Designer': ['product designer', 'ux designer', 'ui designer', 'ux/ui designer', 'ui/ux designer', 'designer'],
  'Product Manager': ['product manager', 'PM'],
  Recruiter: ['recruiter'],
};

// Phrases that contain an alias but mean something outside the data. They claim their words and
// ground nothing, so "Washington DC" can't be read as the state of Washington.
const NON_VALUES: readonly string[] = ['washington dc', 'washington d.c.', 'washington, dc', 'washington, d.c.'];

// Multi-word employers are also called by their first word ("ex-Meridian"), when that is unambiguous.
function employerAliases(): Readonly<Record<string, readonly string[]>> {
  const firstWords = EMPLOYERS.map((e) => e.split(' ')[0]?.toLowerCase() ?? '');
  return Object.fromEntries(
    EMPLOYERS.map((employer, i) => {
      const first = firstWords[i] ?? '';
      const unique = employer.includes(' ') && firstWords.filter((w) => w === first).length === 1;
      return [employer, unique ? [employer.toLowerCase(), first] : [employer.toLowerCase()]];
    }),
  );
}

export const LEXICON: Record<LexiconCategory, Readonly<Record<string, readonly string[]>>> = {
  city: CITY_ALIASES,
  state: STATE_ALIASES,
  employer: employerAliases(),
  school: SCHOOL_ALIASES,
  skill: Object.fromEntries(SKILLS.map((s) => [s, SKILL_ALIASES[s] ?? [s.toLowerCase()]])),
  role: ROLE_ALIASES,
};

// Every vocabulary value, per category, so tests can prove the lexicon covers all of them.
export const LEXICON_VOCABULARY: Record<LexiconCategory, readonly string[]> = {
  city: CITIES,
  state: STATES,
  employer: EMPLOYERS,
  school: SCHOOLS,
  skill: SKILLS,
  role: ROLES,
};

export type Mention = { category: LexiconCategory; value: string; start: number; end: number };

// category null: a NON_VALUES phrase, which claims its words but is never returned. `word` is the
// alias's first word, which any match must contain verbatim (in the alias's case rule). The regex is
// built the first time a brief contains that word.
type Matcher = { category: LexiconCategory | null; value: string; word: string; caseSensitive: boolean; source: string; pattern?: RegExp };
type RawMatch = Omit<Mention, 'category'> & { category: LexiconCategory | null };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function matcher(category: LexiconCategory | null, value: string, alias: string): Matcher {
  const caseSensitive = alias !== alias.toLowerCase();
  const words = alias.split(/[\s-]+/);
  const body = words.map(escapeRegExp).join('[\\s-]*');
  return { category, value, word: words[0] ?? '', caseSensitive, source: `(?<![\\p{L}\\p{N}])${body}s?(?![\\p{L}\\p{N}])` };
}

const patternOf = (m: Matcher) => (m.pattern ??= new RegExp(m.source, m.caseSensitive ? 'gu' : 'giu'));

let matchers: Matcher[] | undefined;

function allMatchers(): Matcher[] {
  matchers ??= [
    ...Object.entries(LEXICON).flatMap(([category, values]) =>
      Object.entries(values).flatMap(([value, aliases]) => aliases.map((alias) => matcher(category as LexiconCategory, value, alias))),
    ),
    ...NON_VALUES.map((phrase) => matcher(null, phrase, phrase)),
  ];
  return matchers;
}

/**
 * The text as the case-insensitive aliases are screened against it. Under /iu an ASCII letter
 * matches only itself in either case, ſ (s) and K (the Kelvin sign, which toLowerCase already
 * turns into k), and every alias is ASCII (both are tested), so an alias whose first word isn't in
 * this string can't match.
 */
const screenText = (text: string) => text.toLowerCase().replaceAll('\u017f', 's');

/**
 * Every vocabulary value the text mentions. A match inside a longer match is not a mention
 * ("React" in "React Native", "New York" in "New York University"); equal spans all count
 * ("Illinois" is both the state and the school).
 */
export function findMentions(text: string): Mention[] {
  const raw: RawMatch[] = [];
  const screened = screenText(text);
  for (const m of allMatchers()) {
    // A brief mentions a handful of the ~290 aliases. Skipping the rest saves building, running and
    // (the first few times in a process) compiling their Unicode regexes: ~200–300 ms a call before.
    if (!(m.caseSensitive ? text : screened).includes(m.word)) continue;
    for (const hit of text.matchAll(patternOf(m))) {
      raw.push({ category: m.category, value: m.value, start: hit.index, end: hit.index + hit[0].length });
    }
  }
  const seen = new Set<string>();
  const mentions: Mention[] = [];
  for (const m of raw) {
    if (m.category === null) continue;
    const inside = raw.some((o) => o.start <= m.start && o.end >= m.end && o.end - o.start > m.end - m.start);
    const key = `${m.category}\u0000${m.value}\u0000${m.start}`;
    if (inside || seen.has(key)) continue;
    seen.add(key);
    mentions.push({ category: m.category, value: m.value, start: m.start, end: m.end });
  }
  return mentions.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** The values of one category that the text mentions. */
export function mentionedValues(text: string, category: LexiconCategory): Set<string> {
  return new Set(findMentions(text).filter((m) => m.category === category).map((m) => m.value));
}
