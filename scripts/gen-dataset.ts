// npm run gen:data: generates Rosterly's synthetic dataset. It is seeded, so a rerun writes the same
// bytes:
//   - data/candidates.json: 5,000 invented people with invented employers;
//   - data/queries.json: ten briefs whose expected ids come from plain predicates below, never from
//     the search SQL, so the eval and the match_candidates test have an independent answer key;
//   - data/stripe-events.json: a webhook sample (a repeat and an out-of-order pair), signed with the
//     public sample secret;
//   - public/avatars/*.svg and public/logos/*.svg, served by Next from the app's own origin.
// The values a filter can use stay generic on purpose (13 roles, 10 US cities, common skill names,
// real universities), because the prompt, lexicon and mapping table are written against them. Run
// `npm run gen:vocab` afterwards; it also re-checks the invariants the search relies on.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Stripe from 'stripe';

const ROOT = path.resolve(import.meta.dirname, '..');
const SEED = 20261013;
const COUNT = 5000;
const AVATARS = 100;
const THIS_YEAR = 2026;
const SAMPLE_SECRET = 'whsec_rosterly_sample';

// ---- seeded randomness (mulberry32) ----

let state = SEED >>> 0;
function rand(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const chance = (p: number) => rand() < p;

function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

type Weighted<T> = readonly (readonly [T, number])[];

function weighted<T>(pairs: Weighted<T>): T {
  let r = rand() * pairs.reduce((sum, [, w]) => sum + w, 0);
  for (const [value, w] of pairs) {
    r -= w;
    if (r < 0) return value;
  }
  const last = pairs.at(-1);
  if (!last) throw new Error('weighted pick from an empty list');
  return last[0];
}

/** Up to `k` distinct values, each draw weighted. */
function sample<T>(pairs: Weighted<T>, k: number): T[] {
  const pool = [...pairs];
  const out: T[] = [];
  while (out.length < k && pool.length > 0) {
    const value = weighted(pool);
    out.push(value);
    pool.splice(
      pool.findIndex(([v]) => v === value),
      1,
    );
  }
  return out;
}

const join = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- the world ----

const CITIES: Weighted<readonly [city: string, state: string]> = [
  [['New York', 'NY'], 18],
  [['San Francisco', 'CA'], 15],
  [['Seattle', 'WA'], 10],
  [['Los Angeles', 'CA'], 9],
  [['Austin', 'TX'], 9],
  [['Chicago', 'IL'], 9],
  [['Boston', 'MA'], 8],
  [['Denver', 'CO'], 8],
  [['Atlanta', 'GA'], 7],
  [['Miami', 'FL'], 7],
];

const SCHOOLS: Weighted<string> = [
  ['UC Berkeley', 8],
  ['University of Illinois', 8],
  ['University of Michigan', 8],
  ['University of Texas at Austin', 8],
  ['University of Washington', 8],
  ['Georgia Tech', 7],
  ['New York University', 7],
  ['Northeastern University', 7],
  ['Stanford University', 6],
  ['Carnegie Mellon University', 6],
  ['Columbia University', 6],
  ['Cornell University', 6],
  ['MIT', 5],
];
// People often study near where they later work.
const NEARBY_SCHOOLS: Record<string, readonly string[]> = {
  Seattle: ['University of Washington'],
  Austin: ['University of Texas at Austin'],
  Boston: ['MIT', 'Northeastern University'],
  Atlanta: ['Georgia Tech'],
  'New York': ['New York University', 'Columbia University', 'Cornell University'],
  'San Francisco': ['Stanford University', 'UC Berkeley'],
  'Los Angeles': ['UC Berkeley', 'Stanford University'],
  Chicago: ['University of Illinois', 'University of Michigan'],
};

type CompanyType = 'enterprise' | 'startup';
const EMPLOYERS: readonly { name: string; type: CompanyType; color: string }[] = [
  { name: 'Halvorsen Bank', type: 'enterprise', color: '#1E3A8A' },
  { name: 'Ridgeline Mutual', type: 'enterprise', color: '#0F766E' },
  { name: 'Corvane', type: 'enterprise', color: '#334155' },
  { name: 'Oakmere Health', type: 'enterprise', color: '#047857' },
  { name: 'Marlowe Retail', type: 'enterprise', color: '#B45309' },
  { name: 'Vexley Telecom', type: 'enterprise', color: '#6D28D9' },
  { name: 'Carrow Logistics', type: 'enterprise', color: '#C2410C' },
  { name: 'Ellery Energy', type: 'enterprise', color: '#A16207' },
  { name: 'Dunmore Insurance', type: 'enterprise', color: '#155E75' },
  { name: 'Whitlock Media', type: 'enterprise', color: '#9D174D' },
  { name: 'Granitehill Software', type: 'enterprise', color: '#3F3F46' },
  { name: 'Fairhaven Pharma', type: 'enterprise', color: '#0369A1' },
  { name: 'Tolland Aerospace', type: 'enterprise', color: '#1D4ED8' },
  { name: 'Fizzbit', type: 'startup', color: '#DB2777' },
  { name: 'Sproutwise', type: 'startup', color: '#15803D' },
  { name: 'Tinkerbox', type: 'startup', color: '#EA580C' },
  { name: 'Nimbleleaf', type: 'startup', color: '#4D7C0F' },
  { name: 'Larkhill Labs', type: 'startup', color: '#7C3AED' },
  { name: 'Inkwell AI', type: 'startup', color: '#111827' },
  { name: 'Parcelpine', type: 'startup', color: '#0D9488' },
  { name: 'Lanternfish', type: 'startup', color: '#D97706' },
  { name: 'Moonberry', type: 'startup', color: '#86198F' },
  { name: 'Cobaltly', type: 'startup', color: '#2563EB' },
  { name: 'Hushwave', type: 'startup', color: '#0E7490' },
  { name: 'Pocketgrove', type: 'startup', color: '#65A30D' },
  { name: 'Brambleway', type: 'startup', color: '#9F1239' },
  { name: 'Zestline', type: 'startup', color: '#CA8A04' },
  { name: 'Wrenfield', type: 'startup', color: '#475569' },
  { name: 'Pixelmoss', type: 'startup', color: '#059669' },
  { name: 'Cindertrail', type: 'startup', color: '#B91C1C' },
];
// Enterprises employ more people, so they turn up in more careers.
const EMPLOYER_WEIGHTS: Weighted<(typeof EMPLOYERS)[number]> = EMPLOYERS.map((e, i) => [e, (e.type === 'enterprise' ? 13 : 9) + (i % 5)] as const);
const logoUrl = (employer: string) => `/logos/${slug(employer)}.svg`;

type Degree = 'BS' | 'BA' | 'MS' | 'MBA' | 'PhD';
type RoleSpec = {
  weight: number;
  /** Most people in the role have the first few; the rest are occasional. */
  core: readonly string[];
  extra: readonly string[];
  degrees: Weighted<Degree>;
  fields: Weighted<string>;
  focus: readonly string[];
  projects: readonly string[];
  /** Roles someone might have held before this one (an earlier job only). */
  before: readonly string[];
};

const ENGINEER_DEGREES: Weighted<Degree> = [['BS', 55], ['MS', 30], ['BA', 8], ['PhD', 4], ['MBA', 3]];
const ENGINEER_FIELDS: Weighted<string> = [['Computer Science', 60], ['Computer Engineering', 15], ['Electrical Engineering', 8], ['Mathematics', 8], ['Physics', 5], ['Statistics', 4]];

const ROLES: Record<string, RoleSpec> = {
  'Frontend Engineer': {
    weight: 11,
    core: ['React', 'TypeScript', 'JavaScript', 'CSS'],
    extra: ['Next.js', 'Vue', 'Svelte', 'Tailwind', 'Accessibility', 'GraphQL', 'Design Systems'],
    degrees: ENGINEER_DEGREES,
    fields: ENGINEER_FIELDS,
    focus: ['building fast, accessible web apps', 'turning designs into polished interfaces', 'front-end performance and design systems'],
    projects: ['the customer dashboard', 'the checkout flow', 'a shared component library', 'the marketing site', 'the onboarding experience', 'the admin console'],
    before: ['Full Stack Engineer', 'Product Designer'],
  },
  'Backend Engineer': {
    weight: 11,
    core: ['Go', 'Java', 'Python', 'Postgres'],
    extra: ['Node.js', 'Redis', 'Kafka', 'gRPC', 'Rust', 'AWS', 'Kubernetes', 'Docker', 'Scala'],
    degrees: ENGINEER_DEGREES,
    fields: ENGINEER_FIELDS,
    focus: ['building APIs and distributed systems', 'scaling services under heavy traffic', 'payments and data-heavy backends'],
    projects: ['the payments API', 'the order service', 'an event pipeline', 'the search backend', 'the authentication service', 'the billing platform'],
    before: ['Full Stack Engineer', 'DevOps Engineer'],
  },
  'Full Stack Engineer': {
    weight: 10,
    core: ['TypeScript', 'React', 'Node.js', 'Postgres'],
    extra: ['Next.js', 'GraphQL', 'Ruby on Rails', 'Python', 'AWS', 'Tailwind', 'Docker'],
    degrees: ENGINEER_DEGREES,
    fields: ENGINEER_FIELDS,
    focus: ['shipping features from database to UI', 'building products end to end', 'early-stage product engineering'],
    projects: ['the self-serve signup flow', 'the customer portal', 'internal tools', 'the reporting feature', 'the integrations platform'],
    before: ['Frontend Engineer', 'Backend Engineer'],
  },
  'Mobile Engineer': {
    weight: 6,
    core: ['Swift', 'iOS', 'Kotlin', 'Android'],
    extra: ['React Native', 'Flutter', 'TypeScript', 'GraphQL'],
    degrees: ENGINEER_DEGREES,
    fields: ENGINEER_FIELDS,
    focus: ['building native mobile apps', 'offline-first mobile apps', 'consumer apps used by millions'],
    projects: ['the iOS app', 'the Android app', 'mobile checkout', 'push notifications', 'the offline sync layer'],
    before: ['Frontend Engineer'],
  },
  'DevOps Engineer': {
    weight: 6,
    core: ['Kubernetes', 'Terraform', 'Docker', 'AWS'],
    extra: ['GCP', 'Linux', 'Ansible', 'CI/CD', 'Datadog', 'Go', 'Python'],
    degrees: ENGINEER_DEGREES,
    fields: ENGINEER_FIELDS,
    focus: ['infrastructure as code and reliable deploys', 'cloud infrastructure and CI/CD', 'keeping production fast and boring'],
    projects: ['the deployment pipeline', 'the Kubernetes platform', 'cloud cost reduction', 'the observability stack', 'disaster recovery'],
    before: ['Backend Engineer'],
  },
  'Data Engineer': {
    weight: 6,
    core: ['SQL', 'Python', 'Spark', 'Airflow'],
    extra: ['dbt', 'Snowflake', 'Kafka', 'Scala', 'AWS', 'Postgres'],
    degrees: ENGINEER_DEGREES,
    fields: ENGINEER_FIELDS,
    focus: ['reliable data pipelines', 'the modern data stack', 'turning raw events into trusted tables'],
    projects: ['the data warehouse', 'batch and streaming pipelines', 'the analytics models', 'event ingestion'],
    before: ['Backend Engineer', 'Data Scientist'],
  },
  'Machine Learning Engineer': {
    weight: 6,
    core: ['Python', 'PyTorch', 'MLOps', 'LLMs'],
    extra: ['TensorFlow', 'CUDA', 'Kubernetes', 'SQL', 'Docker', 'Machine Learning'],
    degrees: [['MS', 42], ['BS', 35], ['PhD', 20], ['BA', 3]],
    fields: [['Computer Science', 50], ['Mathematics', 15], ['Statistics', 10], ['Physics', 10], ['Electrical Engineering', 10], ['Computer Engineering', 5]],
    focus: ['taking models from notebook to production', 'ML infrastructure and model serving', 'recommendation and ranking systems'],
    projects: ['the recommendation model', 'model serving infrastructure', 'the feature store', 'an LLM-powered assistant', 'the fraud model'],
    before: ['Data Scientist', 'Backend Engineer'],
  },
  'Data Scientist': {
    weight: 7,
    core: ['Python', 'SQL', 'Statistics', 'Machine Learning'],
    extra: ['R', 'Pandas', 'A/B Testing', 'Tableau', 'PyTorch', 'Snowflake'],
    degrees: [['MS', 40], ['BS', 32], ['PhD', 24], ['BA', 4]],
    fields: [['Statistics', 30], ['Computer Science', 25], ['Mathematics', 20], ['Economics', 15], ['Physics', 10]],
    focus: ['experimentation and causal inference', 'turning data into product decisions', 'forecasting and statistical modeling'],
    projects: ['the experimentation program', 'demand forecasting', 'churn models', 'pricing analysis', 'the metrics framework'],
    before: ['Data Engineer'],
  },
  'Product Manager': {
    weight: 9,
    core: ['Roadmapping', 'User Research', 'Analytics'],
    extra: ['A/B Testing', 'SQL', 'Jira', 'Pricing', 'Figma'],
    degrees: [['BS', 35], ['BA', 25], ['MBA', 25], ['MS', 15]],
    fields: [['Computer Science', 25], ['Business', 25], ['Economics', 20], ['Human-Computer Interaction', 10], ['Psychology', 10], ['Mathematics', 10]],
    focus: ['B2B products from discovery to launch', 'data-informed product decisions', 'growth and activation'],
    projects: ['the onboarding redesign', 'a pricing and packaging launch', 'the mobile roadmap', 'the integrations marketplace', 'self-serve growth'],
    before: ['Product Designer', 'Data Scientist', 'Backend Engineer'],
  },
  'Product Designer': {
    weight: 8,
    core: ['Figma', 'Prototyping', 'User Research'],
    extra: ['Design Systems', 'Interaction Design', 'Accessibility', 'Webflow', 'CSS'],
    degrees: [['BA', 55], ['BS', 20], ['MS', 20], ['MBA', 5]],
    fields: [['Design', 40], ['Human-Computer Interaction', 30], ['Fine Arts', 20], ['Psychology', 10]],
    focus: ['simple interfaces for complex workflows', 'design systems and interaction design', 'research-led product design'],
    projects: ['the design system', 'the onboarding redesign', 'the mobile app', 'the analytics dashboard', 'the settings experience'],
    before: ['Frontend Engineer'],
  },
  'Marketing Manager': {
    weight: 6,
    core: ['SEO', 'Content Marketing', 'Lifecycle Marketing'],
    extra: ['Paid Social', 'Brand', 'HubSpot', 'Analytics', 'Webflow', 'A/B Testing'],
    degrees: [['BA', 55], ['MBA', 25], ['BS', 15], ['MS', 5]],
    fields: [['Marketing', 40], ['Communications', 30], ['Business', 20], ['Psychology', 10]],
    focus: ['full-funnel B2B marketing', 'content and organic growth', 'lifecycle and retention marketing'],
    projects: ['the content program', 'lifecycle email', 'paid acquisition', 'a brand refresh', 'product launches'],
    before: ['Account Executive'],
  },
  'Account Executive': {
    weight: 7,
    core: ['Salesforce', 'Enterprise Sales', 'SaaS'],
    extra: ['Negotiation', 'Outbound', 'Pipeline Management', 'HubSpot'],
    degrees: [['BA', 55], ['MBA', 25], ['BS', 20]],
    fields: [['Business', 40], ['Economics', 25], ['Communications', 20], ['Marketing', 15]],
    focus: ['closing mid-market and enterprise deals', 'consultative SaaS sales', 'building pipeline from scratch'],
    projects: ['the enterprise segment', 'new-logo acquisition', 'a regional territory', 'expansion deals with key accounts'],
    before: ['Recruiter', 'Marketing Manager'],
  },
  Recruiter: {
    weight: 7,
    core: ['Sourcing', 'Technical Recruiting', 'Interviewing'],
    extra: ['Greenhouse', 'Employer Branding', 'Negotiation'],
    degrees: [['BA', 65], ['BS', 20], ['MS', 10], ['MBA', 5]],
    fields: [['Psychology', 35], ['Communications', 30], ['Business', 25], ['Economics', 10]],
    focus: ['hiring engineers at fast-growing companies', 'full-cycle technical recruiting', 'great candidate experiences'],
    projects: ['engineering hiring', 'the campus program', 'go-to-market hiring', 'executive searches', 'the interview process'],
    before: ['Account Executive'],
  },
};
const ROLE_WEIGHTS: Weighted<string> = Object.entries(ROLES).map(([role, spec]) => [role, spec.weight] as const);
const ENGINEERING = Object.keys(ROLES).filter((r) => r.endsWith(' Engineer'));

type Seniority = 'junior' | 'mid' | 'senior' | 'staff';
// Seniority is a pure function of years, with disjoint ranges (the mapping table relies on it).
const seniorityOf = (years: number): Seniority => (years <= 2 ? 'junior' : years <= 5 ? 'mid' : years <= 9 ? 'senior' : 'staff');
const PREFIX: Record<Seniority, string> = { junior: 'Junior ', mid: '', senior: 'Senior ', staff: 'Staff ' };
const YEARS: Weighted<number> = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((y) => [y, [5, 6, 7, 7, 7, 7, 7, 7, 7, 6, 6, 6, 5, 5, 4, 4][y] ?? 1] as const);
const OPEN_TO_WORK: Record<Seniority, number> = { junior: 0.34, mid: 0.28, senior: 0.24, staff: 0.2 };
const TENURE: Weighted<number> = [[1, 15], [2, 30], [3, 30], [4, 15], [5, 10]];

const FIRST_NAMES = [
  'Aaliyah', 'Adrian', 'Aiko', 'Alejandro', 'Amina', 'Anders', 'Ananya', 'Arjun', 'Astrid', 'Ava', 'Ayesha', 'Beatriz',
  'Benjamin', 'Bilal', 'Camila', 'Carmen', 'Chen', 'Chidi', 'Chloe', 'Dante', 'Daniela', 'Darius', 'Deepa', 'Diego',
  'Dmitri', 'Ebony', 'Elena', 'Elif', 'Emeka', 'Esther', 'Ethan', 'Farah', 'Felix', 'Fiona', 'Gabriel', 'Grace',
  'Hana', 'Hannah', 'Hassan', 'Helena', 'Hiroshi', 'Ibrahim', 'Imani', 'Ines', 'Isaac', 'Ivy', 'Jamal', 'Javier',
  'Jin', 'Joanna', 'Jonah', 'Julia', 'Kai', 'Kavya', 'Keisha', 'Kenji', 'Kofi', 'Lars', 'Layla', 'Leon',
  'Liam', 'Lucia', 'Luis', 'Marcus', 'Mateo', 'Maya', 'Mei', 'Mira', 'Mohammed', 'Nadia', 'Naomi', 'Nikhil',
  'Nina', 'Noah', 'Nora', 'Olivia', 'Olu', 'Omar', 'Oscar', 'Paloma', 'Priya', 'Quinn', 'Rafael', 'Rania',
  'Ravi', 'Rosa', 'Ruth', 'Sakura', 'Samir', 'Sara', 'Sean', 'Sofia', 'Soren', 'Tariq', 'Tessa', 'Theo',
  'Uma', 'Valentina', 'Victor', 'Wei', 'Xavier', 'Yara', 'Yusuf', 'Zara', 'Zoe',
];
const LAST_NAMES = [
  'Abara', 'Adeyemi', 'Agarwal', 'Alvarez', 'Andersson', 'Bae', 'Banerjee', 'Bennett', 'Bianchi', 'Brennan', 'Brooks',
  'Carter', 'Castillo', 'Chandra', 'Chowdhury', 'Coleman', 'Costa', 'Dahl', 'Delgado', 'Diallo', 'Dubois', 'Eriksen',
  'Farouk', 'Fernandes', 'Fischer', 'Foster', 'Fujita', 'Gallagher', 'Garcia', 'Ghosh', 'Haddad', 'Hansen', 'Hoang',
  'Hughes', 'Ibarra', 'Iyer', 'Jensen', 'Kapoor', 'Kato', 'Kaur', 'Kim', 'Kowalski', 'Kruger', 'Larsen', 'Lindqvist',
  'Lopez', 'Mahmoud', 'Marchetti', 'Mendes', 'Mensah', 'Moreau', 'Morgan', 'Murphy', 'Nakamura', 'Novak', 'Nwosu',
  'Okafor', 'Olsen', 'Ortega', 'Osei', 'Park', 'Patel', 'Petrov', 'Quintero', 'Rahman', 'Ramos', 'Reed', 'Reyes',
  'Rossi', 'Saito', 'Salazar', 'Santos', 'Schmidt', 'Sharma', 'Silva', 'Singh', 'Sokolov', 'Sullivan', 'Suzuki',
  'Tanaka', 'Torres', 'Tran', 'Turner', 'Ueda', 'Varga', 'Vasquez', 'Volkov', 'Wagner', 'Walsh', 'Ward', 'Watanabe',
  'Weiss', 'Xu', 'Yamamoto', 'Yilmaz', 'Young', 'Zhang', 'Zhou', 'Ziegler',
];

// ---- candidates ----

type Experience = {
  title: string;
  company: string;
  company_logo_url: string;
  company_type: CompanyType;
  start_year: number;
  end_year: number | null;
  description: string;
};
type Candidate = {
  id: string;
  full_name: string;
  avatar_url: string;
  headline: string;
  current_title: string;
  current_company: string;
  current_company_logo_url: string;
  role: string;
  seniority: Seniority;
  years_experience: number;
  location: { city: string; state: string; country: string };
  open_to_work: boolean;
  skills: string[];
  experiences: Experience[];
  education: { school: string; degree: Degree; field: string; graduation_year: number }[];
};

const ENGINEERING_VERBS = ['Built', 'Shipped', 'Owned', 'Worked on', 'Rebuilt'];
const BUSINESS_VERBS = ['Owned', 'Ran', 'Led', 'Grew', 'Drove'];

function description(role: string, company: string, skills: readonly string[], lead: boolean): string {
  const spec = ROLES[role];
  if (!spec) throw new Error(`unknown role ${role}`);
  const verb = lead ? 'Led' : pick(ENGINEERING.includes(role) ? ENGINEERING_VERBS : BUSINESS_VERBS);
  return `${verb} ${pick(spec.projects)} at ${company}, mostly with ${join(skills)}.`;
}

function makeCandidate(n: number): Candidate {
  const role = weighted(ROLE_WEIGHTS);
  const spec = ROLES[role];
  if (!spec) throw new Error(`unknown role ${role}`);
  const years = weighted(YEARS);
  const seniority = seniorityOf(years);
  const [city, state] = weighted(CITIES);

  const skillCount = weighted([[3, 20], [4, 25], [5, 25], [6, 18], [7, 12]] as const);
  const skills = sample([...spec.core.map((s) => [s, 4] as const), ...spec.extra.map((s) => [s, 1] as const)], skillCount);

  // Jobs from the first one onwards; the last span is the current job.
  const careerStart = THIS_YEAR - years;
  const spans: { start: number; end: number | null }[] = [];
  for (let start = careerStart; ; ) {
    const length = weighted(TENURE);
    if (start + length >= THIS_YEAR || spans.length === 4) {
      spans.push({ start, end: null });
      break;
    }
    spans.push({ start, end: start + length });
    start += length;
  }
  const changedRole = spans.length >= 2 && chance(0.15) ? pick(spec.before) : undefined;
  let previous: (typeof EMPLOYERS)[number] | undefined;
  const experiences = spans.map((span, i): Experience => {
    const employer = previous && chance(0.15) ? previous : weighted(EMPLOYER_WEIGHTS.filter(([e]) => e !== previous));
    previous = employer;
    const current = span.end === null;
    const jobRole = i === 0 && changedRole ? changedRole : role;
    const level = current ? seniority : seniorityOf((span.end ?? THIS_YEAR) - careerStart);
    const mentioned = current ? skills.slice(0, int(1, Math.min(3, skills.length))) : sample(skills.map((s) => [s, 1] as const), int(1, 2));
    return {
      title: `${PREFIX[level]}${jobRole}`,
      company: employer.name,
      company_logo_url: logoUrl(employer.name),
      company_type: employer.type,
      start_year: span.start,
      end_year: span.end,
      description: jobRole === role ? description(role, employer.name, mentioned, current && seniority === 'staff' && chance(0.5)) : description(jobRole, employer.name, ROLES[jobRole]?.core.slice(0, 2) ?? [], false),
    };
  });
  experiences.reverse();
  const now = experiences[0];
  if (!now) throw new Error('a candidate without a job');

  const degree = weighted(spec.degrees);
  const nearby = NEARBY_SCHOOLS[city];
  const school = nearby && chance(0.4) ? pick(nearby) : weighted(SCHOOLS);
  const field = degree === 'MBA' ? 'Business' : weighted(spec.fields);
  const graduation = Math.min(THIS_YEAR, careerStart - (degree === 'BS' || degree === 'BA' ? weighted([[0, 60], [1, 40]] as const) : 0));

  const headline = weighted([
    [`${now.title} · ${pick(spec.focus)}`, 4],
    [`${now.title} at ${now.company}`, 3],
    [`${now.title} · ${join(skills.slice(0, 3))}`, 3],
  ] as const);

  return {
    id: `cand_${String(n).padStart(4, '0')}`,
    full_name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
    avatar_url: `/avatars/avatar-${String(int(1, AVATARS)).padStart(3, '0')}.svg`,
    headline,
    current_title: now.title,
    current_company: now.company,
    current_company_logo_url: now.company_logo_url,
    role,
    seniority,
    years_experience: years,
    location: { city, state, country: 'US' },
    open_to_work: chance(OPEN_TO_WORK[seniority]),
    skills,
    experiences,
    education: [{ school, degree, field, graduation_year: graduation }],
  };
}

const candidates = Array.from({ length: COUNT }, (_, i) => makeCandidate(i + 1));

const used = new Set(candidates.flatMap((c) => c.skills));
const missing = Object.values(ROLES)
  .flatMap((s) => [...s.core, ...s.extra])
  .filter((s) => !used.has(s));
if (missing.length) throw new Error(`skills nobody has: ${missing.join(', ')}`);

// ---- queries: the answer key comes from these predicates, not from the search SQL ----

const isEngineer = (c: Candidate) => ENGINEERING.includes(c.role);
const has = (c: Candidate, ...skills: string[]) => skills.every((s) => c.skills.includes(s));
const QUERIES: readonly { brief: string; match: (c: Candidate) => boolean }[] = [
  { brief: 'senior Go engineers in Seattle', match: (c) => isEngineer(c) && c.seniority === 'senior' && c.location.city === 'Seattle' && has(c, 'Go') },
  { brief: 'data engineers who know Airflow and dbt', match: (c) => c.role === 'Data Engineer' && has(c, 'Airflow', 'dbt') },
  { brief: 'recruiters in Chicago who are open to work', match: (c) => c.role === 'Recruiter' && c.location.city === 'Chicago' && c.open_to_work },
  { brief: 'machine learning engineers who studied at Carnegie Mellon', match: (c) => c.role === 'Machine Learning Engineer' && c.education.some((e) => e.school === 'Carnegie Mellon University') },
  { brief: 'product managers in Boston with an MBA', match: (c) => c.role === 'Product Manager' && c.location.city === 'Boston' && c.education.some((e) => e.degree === 'MBA') },
  { brief: 'staff Android engineers currently at a startup', match: (c) => isEngineer(c) && c.seniority === 'staff' && has(c, 'Android') && c.experiences[0]?.company_type === 'startup' },
  { brief: 'account executives in Texas who use Salesforce', match: (c) => c.role === 'Account Executive' && c.location.state === 'TX' && has(c, 'Salesforce') },
  {
    brief: 'full stack engineers who used to work at Halvorsen Bank',
    match: (c) => c.role === 'Full Stack Engineer' && c.experiences.slice(1).some((e) => e.company === 'Halvorsen Bank') && c.experiences[0]?.company !== 'Halvorsen Bank',
  },
  { brief: 'frontend engineers in Denver with 5 to 8 years of experience', match: (c) => c.role === 'Frontend Engineer' && c.location.city === 'Denver' && c.years_experience >= 5 && c.years_experience <= 8 },
  // Security clearance isn't in the data, so the right answer is nobody.
  { brief: 'data scientists in Miami with a security clearance', match: () => false },
];
const queries = QUERIES.map((q) => ({ brief: q.brief, expected_ids: candidates.filter(q.match).map((c) => c.id) }));

// ---- the Stripe webhook sample ----

// 2026-10-12 16:00 UTC. Signed ahead of any replay, so the webhook must accept old signatures.
const T0 = 1791820800;
const MONTH = 30 * 24 * 60 * 60;
type SampleEvent = { description: string; signedAt: number; id: string; created: number; type: string; company: string; status: string };
const SAMPLE: readonly SampleEvent[] = [
  { description: 'asterwell subscribes', signedAt: T0, id: 'evt_demo_asterwell_1', created: T0, type: 'customer.subscription.created', company: 'asterwell', status: 'active' },
  { description: 'the same event delivered again', signedAt: T0 + 9, id: 'evt_demo_asterwell_1', created: T0, type: 'customer.subscription.created', company: 'asterwell', status: 'active' },
  { description: "glenfold's newer event arrives first", signedAt: T0 + 155, id: 'evt_demo_glenfold_2', created: T0 + 150, type: 'customer.subscription.updated', company: 'glenfold', status: 'active' },
  { description: "glenfold's older event arrives late", signedAt: T0 + 160, id: 'evt_demo_glenfold_1', created: T0 + 90, type: 'customer.subscription.created', company: 'glenfold', status: 'incomplete' },
  { description: 'asterwell cancels', signedAt: T0 + 241, id: 'evt_demo_asterwell_2', created: T0 + 240, type: 'customer.subscription.deleted', company: 'asterwell', status: 'canceled' },
];
const stripeEvents = {
  note: `Rosterly's webhook sample. POST each payload, byte for byte, to /api/billing/events with its Stripe-Signature header. The signatures use the public sample secret ${SAMPLE_SECRET} and were made ahead of time, so the webhook accepts signatures of any age (npm run replay:stripe -- --resign re-signs them with your own secret).`,
  events: SAMPLE.map((e) => {
    const payload = JSON.stringify({
      id: e.id,
      object: 'event',
      api_version: '2026-09-30',
      created: e.created,
      livemode: false,
      type: e.type,
      data: { object: { id: `sub_demo_${e.company}`, object: 'subscription', customer: `cus_demo_${e.company}`, status: e.status, metadata: { company: e.company }, current_period_end: e.created + MONTH } },
    });
    return { description: e.description, headers: { 'Stripe-Signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: SAMPLE_SECRET, timestamp: e.signedAt }) }, payload };
  }),
  expected_plans_after: { asterwell: 'free', glenfold: 'paid' },
};

// ---- images ----

const PALETTES = [
  ['#F4E4D7', '#E07A5F', '#3D405B', '#81B29A'],
  ['#E8EEF7', '#4F6DF5', '#F2B84B', '#1F2A44'],
  ['#FDF0E6', '#F28C6B', '#2A9D8F', '#264653'],
  ['#EEF6F0', '#5BAA7C', '#F4C95D', '#30475E'],
  ['#F6EEF9', '#9B5DE5', '#F15BB5', '#2B2D42'],
  ['#FFF4E0', '#FFB347', '#5C6BC0', '#263238'],
  ['#E9F5F9', '#38A3C9', '#F07167', '#1D3557'],
  ['#F3F0EA', '#C17C74', '#7D8F69', '#3E3A39'],
  ['#EDF2FB', '#8EA8FF', '#FF9F80', '#22223B'],
  ['#F7F3E8', '#D4A373', '#588157', '#2F3E46'],
] as const;

// Abstract, so no avatar pretends to be a real face.
function avatarSvg(i: number): string {
  const [bg, a, b, c] = PALETTES[i % PALETTES.length] ?? PALETTES[0];
  const [first, second] = chance(0.5) ? [a, b] : [b, a];
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="80" height="80">',
    `<rect width="80" height="80" fill="${bg}"/>`,
    `<rect x="-10" y="${int(26, 40)}" width="100" height="${int(14, 26)}" fill="${first}" transform="rotate(${int(0, 179)} 40 40)"/>`,
    `<circle cx="${40 + int(-16, 16)}" cy="${40 + int(-16, 16)}" r="${int(11, 19)}" fill="${second}"/>`,
    `<line x1="-10" y1="${int(20, 60)}" x2="90" y2="${int(20, 60)}" stroke="${c}" stroke-width="3" stroke-linecap="round" transform="rotate(${int(0, 179)} 40 40)"/>`,
    '</svg>',
    '',
  ].join('');
}

function logoSvg(name: string, color: string): string {
  const words = name.split(' ');
  const mark = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.charAt(0);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">',
    `<rect width="64" height="64" rx="14" fill="${color}"/>`,
    `<text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="${mark.length > 1 ? 25 : 32}" font-weight="700" letter-spacing="-0.5" fill="#FFFFFF">${mark}</text>`,
    '</svg>',
    '',
  ].join('');
}

// ---- write ----

const write = (file: string, text: string) => writeFileSync(path.join(ROOT, file), text);
// One candidate per line keeps diffs of a regenerated file readable.
write('data/candidates.json', `[\n${candidates.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`);
write('data/queries.json', `${JSON.stringify(queries, null, 2)}\n`);
write('data/stripe-events.json', `${JSON.stringify(stripeEvents, null, 2)}\n`);

for (const dir of ['public/avatars', 'public/logos']) {
  rmSync(path.join(ROOT, dir), { recursive: true, force: true });
  mkdirSync(path.join(ROOT, dir), { recursive: true });
}
for (let i = 1; i <= AVATARS; i++) write(`public/avatars/avatar-${String(i).padStart(3, '0')}.svg`, avatarSvg(i));
for (const e of EMPLOYERS) write(`public/logos/${slug(e.name)}.svg`, logoSvg(e.name, e.color));

console.log(`✔ wrote ${candidates.length} candidates, ${queries.length} queries, ${stripeEvents.events.length} webhook events, ${AVATARS} avatars and ${EMPLOYERS.length} logos`);
for (const q of queries) console.log(`  ${String(q.expected_ids.length).padStart(4)}  ${q.brief}`);
