import 'server-only';
// What a verified Stripe event means for the plan (PLAN.md § 3.6, DECISIONS.md "which Stripe event
// types change the plan"), and handing it to apply_stripe_event, which makes it idempotent and
// order-safe. A company is paid while any of its subscriptions is active or trialing (get_plan).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { sanitizeDeep } from '@/lib/shared/sanitize';
import { supabaseSecretKey, supabaseUrl } from '../env';
import { NO_SESSION } from '../supabase';

/** What apply_stripe_event did, or `unreadable`: signed, but with no id, type or created to record. */
export const Outcome = z.enum(['applied', 'stale', 'duplicate', 'ignored', 'unknown_company']);
export type Outcome = z.infer<typeof Outcome> | 'unreadable';

export type SubscriptionChange = {
  id: string;
  status: string;
  /** metadata.company; when absent, the company that already has this subscription. */
  company: string | null;
  customer: string | null;
  currentPeriodEnd: number | null;
};

export type StripeEventRecord = {
  id: string;
  type: string;
  created: number;
  /** Null for an event that changes no subscription: it is recorded and ignored. */
  change: SubscriptionChange | null;
};

// 9999-12-31T23:59:59Z: a larger timestamp would overflow Postgres' timestamptz and fail the event.
const MAX_TIMESTAMP = 253_402_300_799;
const Id = z.string().trim().min(1).max(255);
const Timestamp = z.int().min(0).max(MAX_TIMESTAMP);
/** A Stripe id, or the expanded object that carries it. */
const IdRef = z.union([Id, z.object({ id: Id }).transform((o) => o.id)]);
/** A field used only when it's well-formed: anything else reads as absent instead of failing the event. */
const lenient = <T extends z.ZodType>(schema: T) => schema.nullish().catch(null);
const Metadata = lenient(z.object({ company: lenient(z.string().trim().min(1).max(255)) }));

const Envelope = z.object({
  id: Id,
  type: z.string().trim().min(1).max(255),
  created: Timestamp,
  data: lenient(z.object({ object: z.unknown() })),
});

const Subscription = z.object({
  object: z.literal('subscription').optional(),
  id: Id,
  // Stored as sent, so a status Stripe adds later is kept and reads as "not paid".
  status: z.string().trim().min(1).max(64).toLowerCase(),
  customer: lenient(IdRef),
  metadata: Metadata,
  current_period_end: lenient(Timestamp),
});

// A completed subscription checkout whose first payment succeeded (or needed none: a trial or a
// full discount) means its subscription is active. Stripe documents this as the provisioning signal.
const PaidCheckout = z.object({
  object: z.literal('checkout.session').optional(),
  mode: z.literal('subscription'),
  status: z.literal('complete').nullish(),
  payment_status: z.enum(['paid', 'no_payment_required']),
  subscription: IdRef,
  customer: lenient(IdRef),
  metadata: Metadata,
});
const CHECKOUT_PAID_TYPES = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

function subscriptionChange(type: string, object: unknown): SubscriptionChange | null {
  if (type.startsWith('customer.subscription.')) {
    const s = Subscription.safeParse(object);
    if (!s.success) return null;
    return {
      id: s.data.id,
      // A deleted subscription is over, whatever status the payload carries.
      status: type === 'customer.subscription.deleted' ? 'canceled' : s.data.status,
      company: s.data.metadata?.company ?? null,
      customer: s.data.customer ?? null,
      currentPeriodEnd: s.data.current_period_end ?? null,
    };
  }
  if (CHECKOUT_PAID_TYPES.has(type)) {
    const c = PaidCheckout.safeParse(object);
    if (!c.success) return null;
    return { id: c.data.subscription, status: 'active', company: c.data.metadata?.company ?? null, customer: c.data.customer ?? null, currentPeriodEnd: null };
  }
  // invoice.*, payment_intent.*, customer.* and the rest change no subscription: Stripe reports every
  // status change as a customer.subscription.* event, and an invoice can be paid or fail after the
  // subscription it belongs to has ended.
  return null;
}

/** The parts of a verified event we act on, or null when it has nothing to record it under. */
export function readStripeEvent(event: unknown): StripeEventRecord | null {
  const envelope = Envelope.safeParse(sanitizeDeep(event));
  if (!envelope.success) return null;
  const { id, type, created, data } = envelope.data;
  return { id, type, created, change: subscriptionChange(type, data?.object) };
}

let service: SupabaseClient | undefined;

// The app's only use of the secret key (CLAUDE.md § Security rules): apply_stripe_event is
// executable by service_role alone, and the route calls this only after the signature matched.
function serviceClient(): SupabaseClient {
  service ??= createClient(supabaseUrl(), supabaseSecretKey(), { auth: NO_SESSION });
  return service;
}

export async function applyStripeEvent(event: unknown): Promise<Outcome> {
  const record = readStripeEvent(event);
  if (!record) {
    console.warn('[billing] a signed event had no usable id, type or created; ignored');
    return 'unreadable';
  }
  const { change } = record;
  const { data, error } = await serviceClient().rpc('apply_stripe_event', {
    p_event_id: record.id,
    p_type: record.type,
    p_created: record.created,
    p_subscription_id: change?.id ?? null,
    p_status: change?.status ?? null,
    p_company: change?.company ?? null,
    p_customer: change?.customer ?? null,
    p_current_period_end: change?.currentPeriodEnd ?? null,
  });
  // Not a DbError: http.ts would map some codes to 4xx, and a webhook answers 400 only for a bad
  // signature. A failure to store the event is a 500, so Stripe delivers it again later.
  if (error) throw new Error(`apply_stripe_event failed (${error.code}): ${error.message}`);
  return Outcome.parse(data);
}
