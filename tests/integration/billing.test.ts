// The Stripe webhook end to end (PLAN.md § 3.6, M8): the route handler is called directly, with real
// signature verification and the real apply_stripe_event through PostgREST, and the plan is read
// back with get_plan as each company's recruiter.
//
// The sample events name asterwell and glenfold, so their subscriptions and the sample's event ids are
// saved first, cleared for each scenario, and restored afterwards. Every other test uses throwaway
// companies and its own event ids.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/billing/events/route';
import { applyStripeEvent } from '@/lib/server/billing/apply-event';
import { DEMO_ACCOUNTS } from '@/lib/shared/demo-accounts';
import { closeDb, db } from './helpers/db';
import { publicClient, signIn, type Session } from './helpers/supabase';
import { createTenant, type Tenant } from './helpers/tenant';

const SAMPLE_SECRET = 'whsec_rosterly_sample';
const OTHER_SECRET = 'whsec_server_own_secret_for_this_test';

type SampleEvent = { description: string; headers: { 'Stripe-Signature': string }; payload: string };
const FILE = JSON.parse(readFileSync('data/stripe-events.json', 'utf8')) as {
  events: SampleEvent[];
  expected_plans_after: { asterwell: string; glenfold: string };
};
const SAMPLE = FILE.events;
const SAMPLE_EVENT_IDS = [...new Set(SAMPLE.map((e) => (JSON.parse(e.payload) as { id: string }).id))];

/** PLAN.md § 3.6: [asterwell, glenfold] after each sample event, from a fresh seed (both free). */
const EXPECTED_STEPS = [
  ['paid', 'free'], // asterwell subscribes
  ['paid', 'free'], // the same event again
  ['paid', 'paid'], // glenfold's newer event (updated, active)
  ['paid', 'paid'], // glenfold's older event (created, incomplete): stale
  ['free', 'paid'], // asterwell cancels
];

type Delivery = { status: number; body: unknown };

async function deliver(payload: string, signature: string | null): Promise<Delivery> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['stripe-signature'] = signature;
  const res = await POST(new Request('http://localhost:3000/api/billing/events', { method: 'POST', body: payload, headers }));
  return { status: res.status, body: await res.json() };
}

const sign = (payload: string, secret: string) => Stripe.webhooks.generateTestHeaderString({ payload, secret });
const OK = { status: 200, body: { received: true } };

let asterwell: Session, glenfold: Session;
let companyIds: string[] = [];
let saved: { subscriptions: unknown[]; events: unknown[] } = { subscriptions: [], events: [] };

async function planOf(session: Session): Promise<{ plan: string; searches_remaining: number | null }> {
  const { data, error } = await session.client.rpc('get_plan');
  if (error) throw new Error(`get_plan failed: ${error.message}`);
  return data as { plan: string; searches_remaining: number | null };
}
const plans = async () => [(await planOf(asterwell)).plan, (await planOf(glenfold)).plan];

async function clearSampleState(): Promise<void> {
  await db().query('delete from public.subscriptions where company_id = any($1::uuid[])', [companyIds]);
  await db().query('delete from public.processed_stripe_events where event_id = any($1)', [SAMPLE_EVENT_IDS]);
}

/** The billing rows the sample can touch, for "nothing changed" checks. */
async function sampleState() {
  const subscriptions = await db().query(
    `select stripe_subscription_id, company_id, customer, status, current_period_end, last_event_id, last_event_created, last_event_type, updated_at
     from public.subscriptions where company_id = any($1::uuid[]) order by 1`,
    [companyIds],
  );
  const events = await db().query('select * from public.processed_stripe_events where event_id = any($1) order by 1', [SAMPLE_EVENT_IDS]);
  return { subscriptions: subscriptions.rows, events: events.rows };
}

beforeAll(async () => {
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', SAMPLE_SECRET);
  [asterwell, glenfold] = (await Promise.all(DEMO_ACCOUNTS.map((a) => signIn(a.email)))) as [Session, Session];
  const { rows } = await db().query<{ id: string }>('select id from public.companies where slug = any($1) order by slug', [['asterwell', 'glenfold']]);
  companyIds = rows.map((r) => r.id);
  expect(companyIds).toHaveLength(2);
  const subscriptions = await db().query('select * from public.subscriptions where company_id = any($1::uuid[])', [companyIds]);
  const events = await db().query('select * from public.processed_stripe_events where event_id = any($1)', [SAMPLE_EVENT_IDS]);
  saved = { subscriptions: subscriptions.rows, events: events.rows };
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await clearSampleState();
  await db().query('insert into public.subscriptions select * from json_populate_recordset(null::public.subscriptions, $1)', [JSON.stringify(saved.subscriptions)]);
  await db().query('insert into public.processed_stripe_events select * from json_populate_recordset(null::public.processed_stripe_events, $1)', [
    JSON.stringify(saved.events),
  ]);
  await closeDb();
});

describe('the sample events, byte for byte', () => {
  beforeEach(clearSampleState);

  it('give the PLAN.md § 3.6 plans after each event', async () => {
    expect(await plans()).toEqual(['free', 'free']);
    for (const [i, e] of SAMPLE.entries()) {
      expect(await deliver(e.payload, e.headers['Stripe-Signature']), e.description).toEqual(OK);
      expect(await plans(), `after ${i + 1}: ${e.description}`).toEqual(EXPECTED_STEPS[i]);
    }
    expect(await plans()).toEqual([FILE.expected_plans_after.asterwell, FILE.expected_plans_after.glenfold]);
    // Paid means no limit.
    expect((await planOf(glenfold)).searches_remaining).toBeNull();
  });

  it('record each event id once, with what it did', async () => {
    for (const e of SAMPLE) await deliver(e.payload, e.headers['Stripe-Signature']);
    const { rows } = await db().query('select event_id, type, created, outcome from public.processed_stripe_events where event_id = any($1) order by created', [
      SAMPLE_EVENT_IDS,
    ]);
    expect(rows).toEqual([
      { event_id: 'evt_demo_asterwell_1', type: 'customer.subscription.created', created: '1791820800', outcome: 'applied' },
      { event_id: 'evt_demo_glenfold_1', type: 'customer.subscription.created', created: '1791820890', outcome: 'stale' },
      { event_id: 'evt_demo_glenfold_2', type: 'customer.subscription.updated', created: '1791820950', outcome: 'applied' },
      { event_id: 'evt_demo_asterwell_2', type: 'customer.subscription.deleted', created: '1791821040', outcome: 'applied' },
    ]);
    const subs = await db().query(
      `select stripe_subscription_id, customer, status, current_period_end, last_event_id, last_event_type
       from public.subscriptions where company_id = any($1::uuid[]) order by 1`,
      [companyIds],
    );
    expect(subs.rows).toEqual([
      {
        stripe_subscription_id: 'sub_demo_asterwell',
        customer: 'cus_demo_asterwell',
        status: 'canceled',
        current_period_end: new Date(1794413040 * 1000),
        last_event_id: 'evt_demo_asterwell_2',
        last_event_type: 'customer.subscription.deleted',
      },
      {
        stripe_subscription_id: 'sub_demo_glenfold',
        customer: 'cus_demo_glenfold',
        status: 'active',
        current_period_end: new Date(1794412950 * 1000),
        last_event_id: 'evt_demo_glenfold_2',
        last_event_type: 'customer.subscription.updated',
      },
    ]);
  });

  it('change nothing when delivered again, even long after (200 every time)', async () => {
    for (const e of SAMPLE) await deliver(e.payload, e.headers['Stripe-Signature']);
    const before = await sampleState();
    // asterwell's original "subscribed, active" event after its cancellation must not revive it.
    for (const e of [...SAMPLE].reverse()) expect(await deliver(e.payload, e.headers['Stripe-Signature'])).toEqual(OK);
    expect(await sampleState()).toEqual(before);
    expect(await plans()).toEqual(['free', 'paid']);
  });

  it('end in the same state in all 120 delivery orders', async () => {
    const orders = permutations([0, 1, 2, 3, 4]);
    expect(orders).toHaveLength(120);
    const finals = new Set<string>();
    for (const order of orders) {
      await clearSampleState();
      for (const i of order) {
        const e = SAMPLE[i];
        if (!e) throw new Error(`no sample event ${i}`);
        expect(await deliver(e.payload, e.headers['Stripe-Signature'])).toEqual(OK);
      }
      expect(await plans(), `order ${order.join(',')}`).toEqual(['free', 'paid']);
      const { rows } = await db().query('select stripe_subscription_id, status, last_event_id from public.subscriptions where company_id = any($1::uuid[]) order by 1', [
        companyIds,
      ]);
      finals.add(JSON.stringify(rows));
    }
    expect([...finals]).toEqual([
      JSON.stringify([
        { stripe_subscription_id: 'sub_demo_asterwell', status: 'canceled', last_event_id: 'evt_demo_asterwell_2' },
        { stripe_subscription_id: 'sub_demo_glenfold', status: 'active', last_event_id: 'evt_demo_glenfold_2' },
      ]),
    ]);
  }, 120_000);

  it('end in the same state when all five arrive at once (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      await clearSampleState();
      const results = await Promise.all(SAMPLE.map((e) => deliver(e.payload, e.headers['Stripe-Signature'])));
      expect(results).toEqual(SAMPLE.map(() => OK));
      expect(await plans(), `round ${round}`).toEqual(['free', 'paid']);
    }
  });
});

describe('the sample re-signed', () => {
  beforeEach(clearSampleState);
  afterEach(() => vi.stubEnv('STRIPE_WEBHOOK_SECRET', SAMPLE_SECRET));

  it('with the sample secret and a fresh timestamp: the same plans', async () => {
    for (const [i, e] of SAMPLE.entries()) {
      expect(await deliver(e.payload, sign(e.payload, SAMPLE_SECRET))).toEqual(OK);
      expect(await plans(), `after ${i + 1}`).toEqual(EXPECTED_STEPS[i]);
    }
  });

  it('with another secret (the server’s own): the same plans, and the original signatures are refused', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', OTHER_SECRET);
    for (const e of SAMPLE) {
      const refused = await deliver(e.payload, e.headers['Stripe-Signature']);
      expect(refused.status).toBe(400);
      expect(refused.body).toEqual({ error: { code: 'invalid_signature', message: expect.any(String) } });
    }
    expect(await sampleState()).toEqual({ subscriptions: [], events: [] });
    for (const [i, e] of SAMPLE.entries()) {
      expect((await deliver(e.payload, sign(e.payload, SAMPLE_SECRET))).status).toBe(400);
      expect(await deliver(e.payload, sign(e.payload, OTHER_SECRET))).toEqual(OK);
      expect(await plans(), `after ${i + 1}`).toEqual(EXPECTED_STEPS[i]);
    }
  });
});

describe('signatures', () => {
  beforeEach(clearSampleState);
  afterEach(() => vi.stubEnv('STRIPE_WEBHOOK_SECRET', SAMPLE_SECRET));
  const first = SAMPLE[0] ?? { payload: '', headers: { 'Stripe-Signature': '' } };
  const header = first.headers['Stripe-Signature'];

  it.each([
    ['missing', first.payload, null, 'missing_signature'],
    ['not a signature', first.payload, 'nonsense', 'invalid_signature'],
    ['for another body', first.payload, SAMPLE[4]?.headers['Stripe-Signature'] ?? '', 'invalid_signature'],
    ['made with another secret', first.payload, sign(first.payload, 'whsec_attacker'), 'invalid_signature'],
    ['valid, but the body was tampered with', first.payload.replace('"asterwell"}', '"glenfold"}'), header, 'invalid_signature'],
    ['valid, but the body is empty', '', header, 'invalid_signature'],
  ])('%s → 400, and nothing is recorded or changed', async (_, payload, signature, code) => {
    const res = await deliver(payload, signature);
    expect(res).toEqual({ status: 400, body: { error: { code, message: expect.any(String) } } });
    expect(await sampleState()).toEqual({ subscriptions: [], events: [] });
    expect(await plans()).toEqual(['free', 'free']);
  });

  it('without a configured secret → 500, and nothing is recorded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    const res = await deliver(first.payload, header);
    expect(res).toEqual({ status: 500, body: { error: { code: 'webhook_not_configured', message: expect.any(String) } } });
    expect(await sampleState()).toEqual({ subscriptions: [], events: [] });
    vi.mocked(console.error).mockRestore();
  });

  it('a body over 1 MB → 400 before verification', async () => {
    const huge = JSON.stringify({ id: 'evt_huge', pad: 'x'.repeat(1024 * 1024) });
    const res = await deliver(huge, sign(huge, SAMPLE_SECRET));
    expect(res).toEqual({ status: 400, body: { error: { code: 'body_too_large', message: expect.any(String) } } });
  });
});

// ---- throwaway companies: event types, statuses, company resolution, ties, concurrency ----

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const tenants: Tenant[] = [];

async function tenant(): Promise<Tenant> {
  const t = await createTenant('billing');
  tenants.push(t);
  return t;
}

afterAll(async () => {
  await Promise.all(tenants.map((t) => t.dispose()));
  await db().query('delete from public.processed_stripe_events where event_id like $1', [`evt_${RUN}_%`]);
});

type StripeObject = Record<string, unknown>;
const eventId = (suffix?: string) => `evt_${RUN}_${suffix ?? ++seq}`;
const payloadOf = (type: string, created: number, object: StripeObject, id = eventId()) =>
  JSON.stringify({ id, object: 'event', api_version: '2025-09-30', created, livemode: false, type, data: { object } });
const subscription = (t: Tenant, status: string, extra: StripeObject = {}) => ({
  id: `sub_${RUN}_${t.slug}`,
  object: 'subscription',
  customer: `cus_${t.slug}`,
  status,
  metadata: { company: t.slug },
  ...extra,
});
const checkout = (t: Tenant, extra: StripeObject = {}) => ({
  id: `cs_${RUN}_${t.slug}`,
  object: 'checkout.session',
  mode: 'subscription',
  status: 'complete',
  payment_status: 'paid',
  subscription: `sub_${RUN}_${t.slug}`,
  customer: `cus_${t.slug}`,
  metadata: { company: t.slug },
  ...extra,
});

/** Delivers a signed event and expects the 200 every validly signed event gets. */
async function send(type: string, created: number, object: StripeObject, id?: string): Promise<string> {
  const eid = id ?? eventId();
  const payload = payloadOf(type, created, object, eid);
  expect(await deliver(payload, sign(payload, SAMPLE_SECRET)), `${type} ${eid}`).toEqual(OK);
  return eid;
}
const planName = async (t: Tenant) => (await planOf(t)).plan;
async function outcome(id: string): Promise<string | undefined> {
  const { rows } = await db().query<{ outcome: string }>('select outcome from public.processed_stripe_events where event_id = $1', [id]);
  return rows[0]?.outcome;
}

const T0 = 1_800_000_000;

describe('subscription statuses', () => {
  it('paid while active or trialing; every other status, known or new, is free', async () => {
    const t = await tenant();
    const steps: [string, string, string][] = [
      ['customer.subscription.created', 'active', 'paid'],
      ['customer.subscription.updated', 'past_due', 'free'],
      ['customer.subscription.updated', 'active', 'paid'],
      ['customer.subscription.updated', 'unpaid', 'free'],
      ['customer.subscription.trial_will_end', 'trialing', 'paid'],
      ['customer.subscription.updated', 'incomplete', 'free'],
      ['customer.subscription.updated', 'trialing', 'paid'],
      ['customer.subscription.paused', 'paused', 'free'],
      ['customer.subscription.resumed', 'active', 'paid'],
      ['customer.subscription.updated', 'incomplete_expired', 'free'],
      ['customer.subscription.updated', 'Active', 'paid'],
      ['customer.subscription.updated', 'some_status_stripe_adds_later', 'free'],
      ['customer.subscription.updated', 'active', 'paid'],
      ['customer.subscription.deleted', 'active', 'free'], // deleted means canceled, whatever it says
    ];
    expect(await planName(t)).toBe('free');
    for (const [i, [type, status, plan]] of steps.entries()) {
      await send(type, T0 + i, subscription(t, status));
      expect(await planName(t), `${type} ${status}`).toBe(plan);
    }
  });

  it('a company with two subscriptions is paid until both have ended', async () => {
    const t = await tenant();
    await send('customer.subscription.created', T0, subscription(t, 'active', { id: `sub_${RUN}_${t.slug}_a` }));
    await send('customer.subscription.created', T0, subscription(t, 'active', { id: `sub_${RUN}_${t.slug}_b` }));
    await send('customer.subscription.deleted', T0 + 10, subscription(t, 'canceled', { id: `sub_${RUN}_${t.slug}_a` }));
    expect(await planName(t)).toBe('paid');
    await send('customer.subscription.deleted', T0 + 20, subscription(t, 'canceled', { id: `sub_${RUN}_${t.slug}_b` }));
    expect(await planName(t)).toBe('free');
  });
});

describe('ordering', () => {
  it('an older event never overwrites newer state, whatever its type', async () => {
    const t = await tenant();
    await send('customer.subscription.deleted', T0 + 100, subscription(t, 'canceled'));
    const stale = [
      await send('customer.subscription.created', T0, subscription(t, 'active')),
      await send('customer.subscription.updated', T0 + 99, subscription(t, 'active')),
      await send('checkout.session.completed', T0 + 50, checkout(t)),
    ];
    expect(await planName(t)).toBe('free');
    expect(await Promise.all(stale.map(outcome))).toEqual(['stale', 'stale', 'stale']);
  });

  it('a newer event for the same subscription wins (a resubscribe after a cancellation)', async () => {
    const t = await tenant();
    await send('customer.subscription.deleted', T0, subscription(t, 'canceled'));
    await send('customer.subscription.updated', T0 + 1, subscription(t, 'active'));
    expect(await planName(t)).toBe('paid');
  });

  it.each([
    ['deleted beats updated', ['customer.subscription.updated', 'active'], ['customer.subscription.deleted', 'canceled'], 'free'],
    ['updated beats created', ['customer.subscription.created', 'active'], ['customer.subscription.updated', 'past_due'], 'free'],
    ['deleted beats created', ['customer.subscription.created', 'active'], ['customer.subscription.deleted', 'canceled'], 'free'],
    ['a paid checkout beats created (incomplete)', ['customer.subscription.created', 'incomplete'], ['checkout.session.completed', 'active'], 'paid'],
    ['updated beats a paid checkout', ['checkout.session.completed', 'active'], ['customer.subscription.updated', 'past_due'], 'free'],
  ])('in the same second, in either order: %s', async (_, [typeA, statusA], [typeB, statusB], plan) => {
    for (const reversed of [false, true]) {
      const t = await tenant();
      const objectOf = (type = '', status = '') => (type.startsWith('checkout.') ? checkout(t) : subscription(t, status));
      const pair = [
        () => send(typeA ?? '', T0, objectOf(typeA, statusA)),
        () => send(typeB ?? '', T0, objectOf(typeB, statusB)),
      ];
      for (const deliverOne of reversed ? pair.reverse() : pair) await deliverOne();
      expect(await planName(t), reversed ? 'reversed' : 'in order').toBe(plan);
    }
  });

  it('the same second and type: the event id decides, so both orders agree', async () => {
    for (const reversed of [false, true]) {
      const t = await tenant();
      const a = () => send('customer.subscription.updated', T0, subscription(t, 'active'), eventId(`${t.slug}_a`));
      const b = () => send('customer.subscription.updated', T0, subscription(t, 'past_due'), eventId(`${t.slug}_b`));
      for (const deliverOne of reversed ? [b, a] : [a, b]) await deliverOne();
      expect(await planName(t)).toBe('free'); // "…_b" sorts last
    }
  });
});

describe('event types beyond customer.subscription.*', () => {
  it('a paid subscription checkout makes the company paid; a later cancellation still ends it', async () => {
    const t = await tenant();
    const id = await send('checkout.session.completed', T0, checkout(t));
    expect([await planName(t), await outcome(id)]).toEqual(['paid', 'applied']);
    await send('customer.subscription.deleted', T0 + 60, subscription(t, 'canceled'));
    expect(await planName(t)).toBe('free');
  });

  it('a checkout whose payment is still processing changes nothing until it succeeds', async () => {
    const t = await tenant();
    const id = await send('checkout.session.completed', T0, checkout(t, { payment_status: 'unpaid' }));
    expect([await planName(t), await outcome(id)]).toEqual(['free', 'ignored']);
    await send('checkout.session.async_payment_succeeded', T0 + 30, checkout(t));
    expect(await planName(t)).toBe('paid');
  });

  it('a one-time payment checkout, an expired one and a failed async payment change nothing', async () => {
    const t = await tenant();
    const ids = [
      await send('checkout.session.completed', T0, checkout(t, { mode: 'payment', subscription: null })),
      await send('checkout.session.expired', T0 + 1, checkout(t, { status: 'expired', payment_status: 'unpaid' })),
      await send('checkout.session.async_payment_failed', T0 + 2, checkout(t, { payment_status: 'unpaid' })),
    ];
    expect(await planName(t)).toBe('free');
    expect(await Promise.all(ids.map(outcome))).toEqual(['ignored', 'ignored', 'ignored']);
  });

  it('invoice events never change the plan: a paid invoice after a cancellation, a failed one while active', async () => {
    const canceled = await tenant();
    await send('customer.subscription.created', T0, subscription(canceled, 'active'));
    await send('customer.subscription.deleted', T0 + 10, subscription(canceled, 'canceled'));
    const invoice = (t: Tenant, status: string) => ({
      id: `in_${RUN}_${t.slug}`,
      object: 'invoice',
      status,
      customer: `cus_${t.slug}`,
      subscription: `sub_${RUN}_${t.slug}`,
      parent: { type: 'subscription_details', subscription_details: { subscription: `sub_${RUN}_${t.slug}`, metadata: { company: t.slug } } },
      metadata: { company: t.slug },
    });
    const paidLate = await send('invoice.paid', T0 + 20, invoice(canceled, 'paid'));
    await send('invoice.payment_succeeded', T0 + 21, invoice(canceled, 'paid'));
    expect([await planName(canceled), await outcome(paidLate)]).toEqual(['free', 'ignored']);

    const active = await tenant();
    await send('customer.subscription.created', T0, subscription(active, 'active'));
    await send('invoice.payment_failed', T0 + 10, invoice(active, 'open'));
    expect(await planName(active)).toBe('paid');
  });

  it('other types are recorded as ignored and change nothing, even with a subscription-shaped object', async () => {
    const t = await tenant();
    const ids = [];
    for (const type of ['customer.created', 'customer.deleted', 'payment_intent.succeeded', 'charge.succeeded', 'product.updated', 'v1.some.future.type']) {
      ids.push(await send(type, T0, subscription(t, 'active')));
    }
    expect(await planName(t)).toBe('free');
    expect(new Set(await Promise.all(ids.map(outcome)))).toEqual(new Set(['ignored']));
  });
});

describe('which company', () => {
  it('an unknown company is recorded and changes no one', async () => {
    const t = await tenant();
    const before = await plans();
    const id = await send('customer.subscription.created', T0, { ...subscription(t, 'active'), metadata: { company: `initech-${RUN}` } });
    expect(await outcome(id)).toBe('unknown_company');
    expect([await planName(t), ...(await plans())]).toEqual(['free', ...before]);
    const { rowCount } = await db().query('select 1 from public.subscriptions where stripe_subscription_id = $1', [`sub_${RUN}_${t.slug}`]);
    expect(rowCount).toBe(0);
  });

  it('an event without metadata.company belongs to the company that already has the subscription', async () => {
    const t = await tenant();
    await send('customer.subscription.created', T0, subscription(t, 'active'));
    await send('customer.subscription.deleted', T0 + 10, { ...subscription(t, 'canceled'), metadata: {} });
    expect(await planName(t)).toBe('free');
    // ...and without metadata or a known subscription, there is no company to apply it to.
    const orphan = await send('customer.subscription.created', T0, { ...subscription(t, 'active'), id: `sub_${RUN}_orphan`, metadata: null });
    expect(await outcome(orphan)).toBe('unknown_company');
  });

  it('matches the company slug case-insensitively', async () => {
    const t = await tenant();
    await send('customer.subscription.created', T0, { ...subscription(t, 'active'), metadata: { company: t.slug.toUpperCase() } });
    expect(await planName(t)).toBe('paid');
  });
});

describe('unusual but validly signed bodies get a 200', () => {
  it('not JSON, or JSON with no event id: nothing to record', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const payload of ['not json', '[]', '{"type":"customer.subscription.created"}']) {
      expect(await deliver(payload, sign(payload, SAMPLE_SECRET))).toEqual(OK);
    }
    vi.mocked(console.warn).mockRestore();
  });

  it('a subscription event with no status is recorded as ignored', async () => {
    const t = await tenant();
    const id = await send('customer.subscription.updated', T0, { ...subscription(t, 'active'), status: undefined });
    expect([await outcome(id), await planName(t)]).toEqual(['ignored', 'free']);
  });

  it('control characters and lone surrogates are sanitised, not a 500', async () => {
    const t = await tenant();
    const id = eventId('nul');
    await send('customer.subscription.created', T0, { ...subscription(t, 'active'), customer: 'cus_\u0000x\uD800' }, `${id}\u0000`);
    expect([await outcome(id), await planName(t)]).toEqual(['applied', 'paid']);
  });
});

describe('concurrency', () => {
  it('20 concurrent deliveries of one event: all 200, applied exactly once', async () => {
    const t = await tenant();
    const payload = payloadOf('customer.subscription.created', T0, subscription(t, 'active'));
    const signature = sign(payload, SAMPLE_SECRET);
    const results = await Promise.all(Array.from({ length: 20 }, () => deliver(payload, signature)));
    expect(results).toEqual(results.map(() => OK));
    expect(await planName(t)).toBe('paid');

    const t2 = await tenant();
    const event = JSON.parse(payloadOf('customer.subscription.created', T0, subscription(t2, 'active'))) as unknown;
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => applyStripeEvent(event)));
    expect(outcomes.filter((o) => o === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(19);
  });

  it('20 events for one subscription at once, newest last: the newest wins', async () => {
    const t = await tenant();
    const statuses = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'active' : 'past_due'));
    const payloads = statuses.map((status, i) => payloadOf('customer.subscription.updated', T0 + i, subscription(t, status)));
    const results = await Promise.all(payloads.map((p) => deliver(p, sign(p, SAMPLE_SECRET))));
    expect(results).toEqual(results.map(() => OK));
    // The newest (created T0 + 19) says past_due.
    expect(await planName(t)).toBe('free');
    const { rows } = await db().query<{ status: string; last_event_created: string }>(
      'select status, last_event_created from public.subscriptions where stripe_subscription_id = $1',
      [`sub_${RUN}_${t.slug}`],
    );
    expect(rows).toEqual([{ status: 'past_due', last_event_created: String(T0 + 19) }]);
  });
});

describe('apply_stripe_event privileges', () => {
  const args = {
    p_event_id: `evt_${RUN}_rpc`,
    p_type: 'customer.subscription.created',
    p_created: T0,
    p_subscription_id: `sub_${RUN}_rpc`,
    p_status: 'active',
    p_company: 'asterwell',
    p_customer: null,
    p_current_period_end: null,
  };

  it('a recruiter and anon cannot call it, even with every argument', async () => {
    for (const client of [asterwell.client, publicClient()]) {
      const { error } = await client.rpc('apply_stripe_event', args);
      expect(error?.code).toBe('42501');
    }
    expect(await outcome(args.p_event_id)).toBeUndefined();
  });
});

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}
