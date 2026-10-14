// UI smoke at 390 px (PLAN.md M11): sign in → search → open a candidate and come back → edit a chip
// → page 2. A throwaway paid company, so asterwell's and glenfold's rows are never touched and the chip
// edit applies at once. Needs the app running with a model key (skipped, and says so, without one).
import { expect, test } from '@playwright/test';
import { closeDb } from '../integration/helpers/db';
import { createTenant, setSubscription, type Tenant } from '../integration/helpers/tenant';

const HAS_MODEL_KEY = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
// 12 backend engineers in Denver know Go and 18 in Seattle, so adding Seattle gives a second page.
const BRIEF = 'Backend engineers in Denver who know Go';

let tenant: Tenant | undefined;

test.beforeAll(async () => {
  if (!HAS_MODEL_KEY) return;
  tenant = await createTenant('ui');
  await setSubscription(tenant.companyId, 'active');
});

test.afterAll(async () => {
  await tenant?.dispose();
  await closeDb();
});

test('login → search → candidate → edit chip → page 2 at 390 px', async ({ page }) => {
  test.skip(!HAS_MODEL_KEY, 'ANTHROPIC_API_KEY is not set (environment or .env.local): the search needs the model');
  if (!tenant) throw new Error('tenant was not created');
  const heading = page.getByRole('heading', { name: /^[\d,]+ (people|person)$/ });

  await page.goto('/login');
  await page.getByLabel('Work email').fill(tenant.email);
  await page.getByLabel('Password').fill(tenant.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Who are you looking for?' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Plan: Paid/ })).toBeVisible();

  await page.getByLabel('Describe who you’re looking for').fill(BRIEF);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(heading).toHaveText('12 people', { timeout: 30_000 });
  const results = page.url();
  for (const chip of ['Backend Engineer', 'Go', 'Denver']) await expect(page.getByRole('button', { name: `${chip}. Edit` })).toBeVisible();

  // The profile says where Back goes and marks the skill the search asked for.
  const first = page.locator('ol > li h3 a').first();
  const name = await first.innerText();
  await first.click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.locator('ul[aria-label="Skills"] li', { hasText: '(matches your search)' })).toHaveText(/^Go/);
  await page.getByRole('link', { name: 'Back to results' }).click();
  await expect(heading).toHaveText('12 people');
  expect(page.url()).toBe(results);

  // Edit the location chip in its bottom sheet; on Paid it applies at once as a new search.
  await page.getByRole('button', { name: 'Denver. Edit' }).click();
  const sheet = page.getByRole('dialog', { name: 'Location' });
  await sheet.getByRole('checkbox', { name: /^Seattle/ }).click();
  await sheet.getByRole('button', { name: 'Apply' }).click();
  await expect(heading).toHaveText('30 people', { timeout: 15_000 });
  expect(page.url()).not.toBe(results);
  await expect(page.getByRole('button', { name: 'Seattle. Edit' })).toBeVisible();

  await page.getByRole('link', { name: 'Next' }).click();
  await expect(page).toHaveURL(/[?&]page=2/);
  await expect(page.getByText('21–30 of 30')).toBeVisible();
  await expect(page.locator('ol > li')).toHaveCount(10);
  await expect(page.getByRole('button', { name: /^Plan: Paid/ })).toBeVisible();
});
