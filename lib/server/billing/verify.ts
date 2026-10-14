import 'server-only';
// Stripe signature verification (PLAN.md § 3.6). Runs against the raw request bytes, with the
// secret read at request time, and makes no network call.
import Stripe from 'stripe';
import { MissingEnvError, stripeWebhookSecret } from '../env';
import { ApiError, badRequest } from '../http';

/** Far above any real Stripe event; the body is read whole before it can be verified. */
export const MAX_EVENT_BYTES = 1024 * 1024;

// Stripe's 300 s default would reject events signed in advance (the sample was signed on
// 2026-10-05). Replaying a captured event is harmless: each event id applies at most once, and an
// older event never overwrites newer state. 0 doesn't disable the check: constructEvent turns it
// into the 300 s default, and verifyHeader's meaning of 0 is due to change (PLAN.md A2).
export const SIGNATURE_TOLERANCE_SECONDS = 100 * 365 * 24 * 60 * 60;

/** Read per request, so the server's own secret applies. Without one, no signature can be judged. */
export function webhookSecret(): string {
  try {
    return stripeWebhookSecret();
  } catch (err) {
    if (!(err instanceof MissingEnvError)) throw err;
    console.error('[billing] STRIPE_WEBHOOK_SECRET is not set: every webhook is refused until it is');
    throw new ApiError(500, 'webhook_not_configured', 'The webhook signing secret is not configured on the server.');
  }
}

/**
 * The event, once the signature matches: the parsed JSON, or null for a signed body that isn't
 * JSON. A missing, malformed or wrong signature is a 400.
 */
export function verifyStripeEvent(raw: Uint8Array, header: string | null, secret: string): unknown {
  if (!header) throw badRequest('missing_signature', 'The Stripe-Signature header is missing.');
  const { signature } = Stripe.webhooks;
  if (!signature) throw new Error('stripe signature helper is unavailable');
  try {
    signature.verifyHeader(raw, header, secret, SIGNATURE_TOLERANCE_SECONDS);
  } catch (err) {
    if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
      throw badRequest('invalid_signature', 'The Stripe-Signature header does not match this body.');
    }
    throw err;
  }
  // Parsed after verifying rather than with constructEvent, so a signed body that isn't JSON is a
  // 200 that changes nothing instead of an unhandled error.
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    return null;
  }
}
