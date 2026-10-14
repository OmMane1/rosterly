// The seeded companies and their recruiter logins. Public by design: the README documents them and
// the login page offers them as one-tap fills.
export const DEMO_PASSWORD = 'rosterly-demo';

export const DEMO_ACCOUNTS = [
  { slug: 'asterwell', name: 'Asterwell', email: 'recruiter@asterwell.test' },
  { slug: 'glenfold', name: 'Glenfold', email: 'recruiter@glenfold.test' },
] as const;

export type DemoAccount = (typeof DEMO_ACCOUNTS)[number];
