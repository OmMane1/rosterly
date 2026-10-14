import 'server-only';
// The demo's one-hour Paid (DECISIONS.md "Stripe Checkout in test mode"). The logins are public, so
// once a Checkout subscription is applied, Stripe is told to cancel it an hour later. Stripe then
// sends customer.subscription.deleted, and the company is Free again the usual way.
import type Stripe from 'stripe';
import { DEMO_PAID_SECONDS } from '@/lib/shared/billing';
import { readStripeEvent } from './apply-event';
import { stripeOrNull } from './stripe';

const CHECKOUT_PAID = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

export type DemoEnd = 'scheduled' | 'skipped' | 'failed';

/**
 * Called only for an event that apply_stripe_event just applied, so the subscription belongs to one
 * of our companies. A session without metadata.company didn't come from our Checkout and is left
 * alone. Best effort: a failure is logged and the webhook still answers 200, and the subscription
 * then stays Paid until someone cancels it in the billing portal.
 */
export async function endDemoLater(event: unknown, stripe: Pick<Stripe, 'subscriptions'> | null = stripeOrNull(), nowMs = Date.now()): Promise<DemoEnd> {
  const record = readStripeEvent(event);
  if (!record?.change?.company || !CHECKOUT_PAID.has(record.type)) return 'skipped';
  if (!stripe) {
    console.warn('[billing] STRIPE_SECRET_KEY is not set, so this upgrade will not end by itself');
    return 'skipped';
  }
  try {
    // Keyed on the event, so a retried delivery doesn't push the end further out.
    await stripe.subscriptions.update(record.change.id, { cancel_at: Math.floor(nowMs / 1000) + DEMO_PAID_SECONDS }, { idempotencyKey: `demo-end-${record.id}` });
    return 'scheduled';
  } catch (err) {
    console.error(`[billing] scheduling the demo's end failed: ${err instanceof Error ? err.name : typeof err}`);
    return 'failed';
  }
}
