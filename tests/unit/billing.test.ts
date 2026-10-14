// lib/server/billing: signature verification and what each Stripe event type means for the plan.
// Applying events (idempotency, ordering) is SQL and is tested in tests/integration/billing.test.ts.
import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStripeEvent } from '@/lib/server/billing/apply-event';
import { SIGNATURE_TOLERANCE_SECONDS, verifyStripeEvent, webhookSecret } from '@/lib/server/billing/verify';
import { ApiError } from '@/lib/server/http';

const SECRET = 'whsec_rosterly_sample';
type SampleEvent = { headers: { 'Stripe-Signature': string }; payload: string };
const SAMPLE = (JSON.parse(readFileSync('data/stripe-events.json', 'utf8')) as { events: SampleEvent[] }).events;

const bytes = (s: string) => new TextEncoder().encode(s);
const sign = (payload: string, secret = SECRET, timestamp?: number) => Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
const rejected = (fn: () => unknown): ApiError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
};

afterEach(() => vi.unstubAllEnvs());

describe('verifyStripeEvent', () => {
  it('accepts every sample event byte for byte, although it was signed days ago', () => {
    for (const e of SAMPLE) {
      expect(verifyStripeEvent(bytes(e.payload), e.headers['Stripe-Signature'], SECRET)).toEqual(JSON.parse(e.payload));
    }
  });

  it('accepts a freshly re-signed event, and one signed years ago', () => {
    const payload = SAMPLE[0]?.payload ?? '';
    expect(verifyStripeEvent(bytes(payload), sign(payload), SECRET)).toEqual(JSON.parse(payload));
    const tenYearsAgo = Math.floor(Date.now() / 1000) - 10 * 365 * 24 * 3600;
    expect(verifyStripeEvent(bytes(payload), sign(payload, SECRET, tenYearsAgo), SECRET)).toEqual(JSON.parse(payload));
    expect(SIGNATURE_TOLERANCE_SECONDS).toBeGreaterThan(50 * 365 * 24 * 3600);
  });

  it('accepts a header that also carries signatures from other secrets (secret rotation)', () => {
    const payload = SAMPLE[0]?.payload ?? '';
    const header = sign(payload);
    const other = sign(payload, 'whsec_old_secret').split(',')[1];
    expect(verifyStripeEvent(bytes(payload), `${header},${other}`, SECRET)).toEqual(JSON.parse(payload));
  });

  const sample = SAMPLE[0] ?? { payload: '', headers: { 'Stripe-Signature': '' } };
  const header = sample.headers['Stripe-Signature'];
  it.each([
    ['no header', sample.payload, null, 'missing_signature'],
    ['an empty header', sample.payload, '', 'missing_signature'],
    ['a header that is not a signature', sample.payload, 'garbage', 'invalid_signature'],
    ['a timestamp but no v1 signature', sample.payload, header.split(',')[0] ?? '', 'invalid_signature'],
    ['a v0 signature only', sample.payload, header.replace('v1=', 'v0='), 'invalid_signature'],
    ['a changed timestamp', sample.payload, header.replace('t=1791820800', 't=1791820801'), 'invalid_signature'],
    ['a tampered body (one character)', sample.payload.replace('"active"', '"activE"'), header, 'invalid_signature'],
    ['a body with a trailing newline', `${sample.payload}\n`, header, 'invalid_signature'],
    ['a re-serialised body', JSON.stringify(JSON.parse(sample.payload), null, 1), header, 'invalid_signature'],
    ['an empty body', '', header, 'invalid_signature'],
    ['another event’s signature', SAMPLE[2]?.payload ?? '', header, 'invalid_signature'],
  ])('rejects %s with a 400', (_, payload, sig, code) => {
    const e = rejected(() => verifyStripeEvent(bytes(payload), sig, SECRET));
    expect([e.status, e.code]).toEqual([400, code]);
  });

  it('rejects a signature made with another secret, and the sample under another secret', () => {
    const payload = sample.payload;
    expect(rejected(() => verifyStripeEvent(bytes(payload), sign(payload, 'whsec_someone_else'), SECRET)).status).toBe(400);
    expect(rejected(() => verifyStripeEvent(bytes(payload), header, 'whsec_server_own_secret')).status).toBe(400);
  });

  it('returns null for a validly signed body that is not JSON', () => {
    expect(verifyStripeEvent(bytes('not json'), sign('not json'), SECRET)).toBeNull();
  });
});

describe('webhookSecret', () => {
  it('reads STRIPE_WEBHOOK_SECRET on every call', () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_first');
    expect(webhookSecret()).toBe('whsec_first');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_second');
    expect(webhookSecret()).toBe('whsec_second');
  });

  it('is a 500 that names no value when the secret is unset or blank', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const value of [undefined, '', '   ']) {
      vi.stubEnv('STRIPE_WEBHOOK_SECRET', value);
      const e = rejected(webhookSecret);
      expect([e.status, e.code]).toEqual([500, 'webhook_not_configured']);
    }
  });
});

const subscriptionEvent = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'evt_1',
  object: 'event',
  type,
  created: 1791820800,
  data: { object: { id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', metadata: { company: 'asterwell' }, ...object } },
  ...extra,
});
const checkoutEvent = (type: string, object: Record<string, unknown>) => ({
  id: 'evt_2',
  type,
  created: 1791820900,
  data: {
    object: {
      id: 'cs_1',
      object: 'checkout.session',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      subscription: 'sub_1',
      customer: 'cus_1',
      metadata: { company: 'glenfold' },
      ...object,
    },
  },
});

describe('readStripeEvent', () => {
  it('reads every sample event', () => {
    const read = SAMPLE.map((e) => readStripeEvent(JSON.parse(e.payload)));
    expect(read[0]).toEqual({
      id: 'evt_demo_asterwell_1',
      type: 'customer.subscription.created',
      created: 1791820800,
      change: { id: 'sub_demo_asterwell', status: 'active', company: 'asterwell', customer: 'cus_demo_asterwell', currentPeriodEnd: 1794412800 },
    });
    expect(read.map((r) => [r?.id, r?.change?.status, r?.change?.company])).toEqual([
      ['evt_demo_asterwell_1', 'active', 'asterwell'],
      ['evt_demo_asterwell_1', 'active', 'asterwell'],
      ['evt_demo_glenfold_2', 'active', 'glenfold'],
      ['evt_demo_glenfold_1', 'incomplete', 'glenfold'],
      ['evt_demo_asterwell_2', 'canceled', 'asterwell'],
    ]);
  });

  it.each(['created', 'updated', 'paused', 'resumed', 'trial_will_end', 'pending_update_applied', 'pending_update_expired', 'some_future_type'])(
    'applies customer.subscription.%s by the status it carries',
    (suffix) => {
      expect(readStripeEvent(subscriptionEvent(`customer.subscription.${suffix}`, { status: 'past_due' }))?.change?.status).toBe('past_due');
    },
  );

  it('treats customer.subscription.deleted as canceled, whatever status it carries', () => {
    expect(readStripeEvent(subscriptionEvent('customer.subscription.deleted', { status: 'active' }))?.change?.status).toBe('canceled');
  });

  it('keeps an unknown status (it reads as not paid) and lowercases it', () => {
    expect(readStripeEvent(subscriptionEvent('customer.subscription.updated', { status: 'some_new_status' }))?.change?.status).toBe('some_new_status');
    expect(readStripeEvent(subscriptionEvent('customer.subscription.updated', { status: ' Active ' }))?.change?.status).toBe('active');
  });

  it('reads an expanded customer, and treats a malformed optional field as absent', () => {
    const r = readStripeEvent(subscriptionEvent('customer.subscription.updated', { customer: { id: 'cus_9', object: 'customer' }, current_period_end: 'soon' }));
    expect(r?.change).toMatchObject({ customer: 'cus_9', currentPeriodEnd: null, status: 'active' });
    const noMeta = readStripeEvent(subscriptionEvent('customer.subscription.updated', { metadata: null }));
    expect(noMeta?.change).toMatchObject({ id: 'sub_1', company: null });
    const badMeta = readStripeEvent(subscriptionEvent('customer.subscription.updated', { metadata: { company: 42 } }));
    expect(badMeta?.change).toMatchObject({ id: 'sub_1', company: null });
    const farFuture = readStripeEvent(subscriptionEvent('customer.subscription.updated', { current_period_end: 1e15 }));
    expect(farFuture?.change?.currentPeriodEnd).toBeNull();
  });

  it('records but ignores a subscription event whose object has no id or status, or is not a subscription', () => {
    for (const object of [{ id: undefined }, { status: undefined }, { status: '' }, { object: 'invoice' }, { status: 'x'.repeat(65) }]) {
      const r = readStripeEvent(subscriptionEvent('customer.subscription.updated', object));
      expect(r).toMatchObject({ id: 'evt_1', change: null });
    }
    expect(readStripeEvent({ id: 'evt_1', type: 'customer.subscription.updated', created: 1 })).toMatchObject({ id: 'evt_1', change: null });
  });

  it('activates the subscription of a paid subscription checkout', () => {
    for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
      expect(readStripeEvent(checkoutEvent(type, {}))?.change).toEqual({ id: 'sub_1', status: 'active', company: 'glenfold', customer: 'cus_1', currentPeriodEnd: null });
    }
    expect(readStripeEvent(checkoutEvent('checkout.session.completed', { payment_status: 'no_payment_required' }))?.change?.status).toBe('active');
    expect(readStripeEvent(checkoutEvent('checkout.session.completed', { subscription: { id: 'sub_x', object: 'subscription' } }))?.change?.id).toBe('sub_x');
  });

  it.each([
    ['unpaid (payment still processing)', 'checkout.session.completed', { payment_status: 'unpaid' }],
    ['a one-time payment', 'checkout.session.completed', { mode: 'payment', subscription: null }],
    ['no subscription id', 'checkout.session.completed', { subscription: null }],
    ['a session that is not complete', 'checkout.session.completed', { status: 'open' }],
    ['an expired session', 'checkout.session.expired', { status: 'expired', payment_status: 'unpaid', subscription: null }],
    ['a failed async payment', 'checkout.session.async_payment_failed', { payment_status: 'unpaid' }],
  ])('records but ignores a checkout that does not mean paid: %s', (_, type, object) => {
    expect(readStripeEvent(checkoutEvent(type, object))).toMatchObject({ type, change: null });
  });

  it.each([
    'invoice.paid',
    'invoice.payment_succeeded',
    'invoice.payment_failed',
    'invoice.created',
    'invoice.finalized',
    'payment_intent.succeeded',
    'charge.succeeded',
    'customer.created',
    'customer.deleted',
    'product.updated',
  ])('records but ignores %s, even when it carries a subscription-like object', (type) => {
    expect(readStripeEvent(subscriptionEvent(type, { status: 'active' }))).toMatchObject({ type, change: null });
  });

  it('returns null when there is nothing to record the event under', () => {
    for (const event of [
      null,
      'evt_1',
      [],
      {},
      { type: 'customer.subscription.updated', created: 1 },
      { id: 'evt_1', created: 1 },
      { id: 'evt_1', type: 'customer.subscription.updated' },
      { id: 'evt_1', type: 'customer.subscription.updated', created: '1791820800' },
      { id: 'evt_1', type: 'customer.subscription.updated', created: -1 },
      { id: 'evt_1', type: 'customer.subscription.updated', created: 1.5 },
      { id: 'x'.repeat(256), type: 'customer.subscription.updated', created: 1 },
      { id: '   ', type: 'customer.subscription.updated', created: 1 },
    ]) {
      expect(readStripeEvent(event)).toBeNull();
    }
  });

  it('sanitises every string before using it', () => {
    const r = readStripeEvent(subscriptionEvent('customer.subscription.updated', { id: 'sub_\u00001', metadata: { company: 'aster\u0007well' } }, { id: 'evt_\u0000x\uD800' }));
    expect(r).toMatchObject({ id: 'evt_x�', change: { id: 'sub_1', company: 'asterwell' } });
  });
});
