// Generates lib/shared/vocabulary.generated.ts from data/candidates.json: the only source of the
// values a filter may use (CLAUDE.md § Search rules). It also asserts the data invariants the schema
// and the mapping table rely on, so a changed dataset fails here instead of silently drifting.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Experience = {
  company: string;
  company_logo_url: string;
  company_type: string;
  end_year: number | null;
};
type Candidate = {
  id: string;
  role: string;
  seniority: string;
  years_experience: number;
  location: { city: string; state: string; country: string };
  skills: string[];
  current_company: string;
  experiences: Experience[];
  education: { school: string; degree: string; field: string; graduation_year: number }[];
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'data/candidates.json';
const TARGET = 'lib/shared/vocabulary.generated.ts';

// Fixed by the schema's CHECK constraints (supabase/migrations/*_schema.sql).
const DB_SENIORITIES = ['junior', 'mid', 'senior', 'staff'];
const DB_COMPANY_TYPES = ['enterprise', 'startup'];

const candidates = JSON.parse(readFileSync(path.join(ROOT, SOURCE), 'utf8')) as Candidate[];

function invariant(ok: boolean, msg: string): asserts ok {
  if (!ok) throw new Error(`${SOURCE}: ${msg}`);
}

// Case-insensitive, then codepoint: stable on every machine (no locale tables involved).
function byName(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
const uniqueSorted = (values: Iterable<string>) => [...new Set(values)].sort(byName);

// One value per key, or the data contradicts itself.
function functional<K extends string, V>(pairs: Iterable<[K, V]>, label: string): Map<K, V> {
  const map = new Map<K, V>();
  for (const [k, v] of pairs) {
    const seen = map.get(k);
    invariant(seen === undefined || seen === v, `${label} "${k}" maps to both ${String(seen)} and ${String(v)}`);
    map.set(k, v);
  }
  return map;
}

invariant(candidates.length > 0, 'no candidates');
invariant(new Set(candidates.map((c) => c.id)).size === candidates.length, 'duplicate candidate ids');

for (const c of candidates) {
  invariant(c.experiences.length > 0, `${c.id} has no experiences`);
  invariant(c.experiences[0]?.end_year === null, `${c.id}: experiences[0] is not the current job`);
  invariant(c.experiences.slice(1).every((e) => e.end_year !== null), `${c.id} has more than one current job`);
  invariant(c.current_company === c.experiences[0]?.company, `${c.id}: current_company differs from experiences[0]`);
  invariant(new Set(c.skills).size === c.skills.length, `${c.id} lists a skill twice`);
}

const allExperiences = candidates.flatMap((c) => c.experiences);
const allEducation = candidates.flatMap((c) => c.education);

const cityState = functional(candidates.map((c) => [c.location.city, c.location.state]), 'city');
const employerType = functional(allExperiences.map((e) => [e.company, e.company_type]), 'employer');
functional(allExperiences.map((e) => [e.company, e.company_logo_url]), 'employer logo');

// Seniority must be a pure function of years with disjoint ranges: the mapping table's
// "experienced → 6+ years = senior ∪ staff" depends on it (PLAN.md § 3.4).
const seniorityYears = new Map<string, { min: number; max: number }>();
for (const c of candidates) {
  const r = seniorityYears.get(c.seniority) ?? { min: Infinity, max: -Infinity };
  seniorityYears.set(c.seniority, { min: Math.min(r.min, c.years_experience), max: Math.max(r.max, c.years_experience) });
}
function yearsOf(seniority: string) {
  const r = seniorityYears.get(seniority);
  invariant(r !== undefined, `no years for seniority ${seniority}`);
  return r;
}
const seniorities = [...seniorityYears.keys()].sort((a, b) => yearsOf(a).min - yearsOf(b).min);
invariant(
  JSON.stringify([...seniorities].sort()) === JSON.stringify([...DB_SENIORITIES].sort()),
  `seniorities ${seniorities.join(',')} differ from the schema's ${DB_SENIORITIES.join(',')}`,
);
seniorities.forEach((s, i) => {
  const next = seniorities[i + 1];
  if (next) invariant(yearsOf(s).max < yearsOf(next).min, `seniority ${s} overlaps ${next} in years`);
});

const companyTypes = uniqueSorted(employerType.values());
invariant(companyTypes.every((t) => DB_COMPANY_TYPES.includes(t)), `unexpected company_type in ${companyTypes.join(',')}`);

const years = candidates.map((c) => c.years_experience);
const gradYears = allEducation.map((e) => e.graduation_year);

// ---- render ----

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const key = (s: string) => (/^[A-Za-z_$][\w$]*$/.test(s) ? s : q(s));

function list(name: string, typeName: string, values: string[]): string {
  return [
    `export const ${name} = [`,
    ...values.map((v) => `  ${q(v)},`),
    '] as const;',
    `export type ${typeName} = (typeof ${name})[number];`,
    '',
  ].join('\n');
}

function record(name: string, type: string, entries: [string, string][]): string {
  return [
    `export const ${name} = {`,
    ...entries.map(([k, v]) => `  ${key(k)}: ${q(v)},`),
    `} as const satisfies ${type};`,
    '',
  ].join('\n');
}

const range = (values: number[]) => `{ min: ${Math.min(...values)}, max: ${Math.max(...values)} }`;

const out = [
  `// Generated by scripts/gen-vocabulary.ts from ${SOURCE}. Do not edit; run \`npm run gen:vocab\`.`,
  '',
  list('ROLES', 'Role', uniqueSorted(candidates.map((c) => c.role))),
  '// Ordered by years of experience, not alphabetically.',
  list('SENIORITIES', 'Seniority', seniorities),
  list('CITIES', 'City', uniqueSorted(cityState.keys())),
  list('STATES', 'State', uniqueSorted(cityState.values())),
  list('COUNTRIES', 'Country', uniqueSorted(candidates.map((c) => c.location.country))),
  list('SKILLS', 'Skill', uniqueSorted(candidates.flatMap((c) => c.skills))),
  list('EMPLOYERS', 'Employer', uniqueSorted(employerType.keys())),
  list('COMPANY_TYPES', 'CompanyType', companyTypes),
  list('SCHOOLS', 'School', uniqueSorted(allEducation.map((e) => e.school))),
  list('DEGREES', 'Degree', uniqueSorted(allEducation.map((e) => e.degree))),
  list('FIELDS', 'Field', uniqueSorted(allEducation.map((e) => e.field))),
  record('CITY_STATE', 'Record<City, State>', [...cityState].sort(([a], [b]) => byName(a, b))),
  record('EMPLOYER_TYPE', 'Record<Employer, CompanyType>', [...employerType].sort(([a], [b]) => byName(a, b))),
  '// Inclusive. Seniority is a pure function of years in this data (asserted by the generator).',
  'export const SENIORITY_YEARS = {',
  ...seniorities.map((s) => `  ${s}: ${range([yearsOf(s).min, yearsOf(s).max])},`),
  '} as const satisfies Record<Seniority, { min: number; max: number }>;',
  '',
  `export const YEARS_EXPERIENCE = ${range(years)} as const;`,
  `export const GRADUATION_YEARS = ${range(gradYears)} as const;`,
  '',
].join('\n');

writeFileSync(path.join(ROOT, TARGET), out);
console.log(`✔ wrote ${TARGET} from ${candidates.length} candidates`);
