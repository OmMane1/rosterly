// lib/server/billing: the test-mode Stripe client, the Checkout Session we ask for, and the demo's
// one-hour end. Nothing here calls Stripe: the end is checked against a stand-in client.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkoutParams, type CheckoutInput } from '@/lib/server/billing/checkout';
import { endDemoLater } from '@/lib/server/billing/demo-end';
import { isTestKey, stripeOrNull } from '@/lib/server/billing/stripe';
import { DEMO_PAID_SECONDS } from '@/lib/shared/billing';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('test mode only', () => {
  it.each([
    ['sk_test_51AbC', true],
    ['rk_test_51AbC', true],
    ['sk_live_51AbC', false],
    ['rk_live_51AbC', false],
    ['pk_test_51AbC', false],
    ['sk_test_', false],
    ['', false],
  ])('%j → %s', (key, ok) => expect(isTestKey(key)).toBe(ok));

  it('without a key, or with a live one, there is no client (and the key is never logged)', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect(stripeOrNull()).toBeNull();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_51SecretValue');
    expect(stripeOrNull()).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain('51SecretValue');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_51AbC');
    expect(stripeOrNull()).not.toBeNull();
  });
});

describe('checkoutParams', () => {
  const base: CheckoutInput = { slug: 'asterwell', companyName: 'Asterwell', email: 'recruiter@asterwell.test', customer: null, price: 'price_123', origin: 'https://rosterly.example' };

  it('is a one-seat subscription that names the company where the webhook reads it', () => {
    const p = checkoutParams(base);
    expect(p).toMatchObject({
      mode: 'subscription',
      line_items: [{ price: 'price_123', quantity: 1 }],
      metadata: { company: 'asterwell' },
      subscription_data: { metadata: { company: 'asterwell' } },
      customer_email: 'recruiter@asterwell.test',
      success_url: 'https://rosterly.example/?upgrade=done',
      cancel_url: 'https://rosterly.example/?upgrade=cancelled',
    });
    expect(p).not.toHaveProperty('customer');
  });

  it("reuses the company's Stripe customer instead of asking for an email", () => {
    const p = checkoutParams({ ...base, customer: 'cus_123' });
    expect(p.customer).toBe('cus_123');
    expect(p).not.toHaveProperty('customer_email');
    expect(checkoutParams({ ...base, email: null })).not.toHaveProperty('customer_email');
  });
});

describe('endDemoLater', () => {
  const NOW = 1_800_000_000_000;
  const completed = (metadata: Record<string, string> = { company: 'asterwell' }) => ({
    id: 'evt_checkout',
    type: 'checkout.session.completed',
    created: 1_800_000_000,
    data: { object: { object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', subscription: 'sub_123', customer: 'cus_123', metadata } },
  });
  const stripe = () => {
    const update = vi.fn(async () => ({}));
    return { client: { subscriptions: { update } } as never, update };
  };

  it('asks Stripe to cancel the subscription an hour from now, keyed on the event', async () => {
    const { client, update } = stripe();
    expect(await endDemoLater(completed(), client, NOW)).toBe('scheduled');
    expect(update).toHaveBeenCalledWith('sub_123', { cancel_at: NOW / 1000 + DEMO_PAID_SECONDS }, { idempotencyKey: 'demo-end-evt_checkout' });
  });

  it('leaves a session alone that our Checkout did not create, and every other event type', async () => {
    const { client, update } = stripe();
    expect(await endDemoLater(completed({}), client, NOW)).toBe('skipped');
    const created = { id: 'evt_sub', type: 'customer.subscription.created', created: 1, data: { object: { id: 'sub_123', status: 'active', metadata: { company: 'asterwell' } } } };
    expect(await endDemoLater(created, client, NOW)).toBe('skipped');
    expect(await endDemoLater(null, client, NOW)).toBe('skipped');
    expect(update).not.toHaveBeenCalled();
  });

  it('without a Stripe key it skips, and a Stripe failure is logged, not thrown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await endDemoLater(completed(), null, NOW)).toBe('skipped');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = { subscriptions: { update: vi.fn(async () => Promise.reject(new Error('network down'))) } } as never;
    expect(await endDemoLater(completed(), failing, NOW)).toBe('failed');
    expect(log).toHaveBeenCalledOnce();
  });
});
