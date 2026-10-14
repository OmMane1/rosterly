// What Paid costs in the demo's Stripe test mode, shared so the Upgrade dialog and the Checkout
// Session always agree (DECISIONS.md "Stripe Checkout in test mode").
export const PAID_PLAN = { name: 'Rosterly Paid', amount: 2900, currency: 'usd', interval: 'month', lookupKey: 'rosterly_paid_monthly' } as const;

/** The demo logins are public, so a test-mode upgrade ends by itself after this long. */
export const DEMO_PAID_SECONDS = 60 * 60;

/** Stripe's test card: any future expiry date and any CVC. */
export const TEST_CARD = '4242 4242 4242 4242';
