import { applyStripeEvent } from '@/lib/server/billing/apply-event';
import { endDemoLater } from '@/lib/server/billing/demo-end';
import { MAX_EVENT_BYTES, verifyStripeEvent, webhookSecret } from '@/lib/server/billing/verify';
import { handler, json, readBody } from '@/lib/server/http';

// Signature verification uses node:crypto.
export const runtime = 'nodejs';

// 400 only for a bad or missing signature; every validly signed event is a 200, including repeats,
// stale events and types that change nothing (PLAN.md § 3.6).
export const POST = handler(async (req: Request) => {
  const secret = webhookSecret();
  // The exact bytes Stripe signed: never parsed and re-serialised before verification.
  const raw = await readBody(req, MAX_EVENT_BYTES);
  const event = verifyStripeEvent(raw, req.headers.get('stripe-signature'), secret);
  if ((await applyStripeEvent(event)) === 'applied') await endDemoLater(event);
  return json({ received: true });
});
