import 'server-only';
// The Stripe API client, in test mode only (DECISIONS.md "Stripe Checkout in test mode"). It opens
// Checkout and the billing portal and ends demo upgrades. The plan itself still changes only through
// signed webhooks (PLAN.md § 3.6).
import Stripe from 'stripe';
import { MissingEnvError, stripeSecretKey } from '../env';
import { ApiError } from '../http';

// A secret or restricted key from test mode. A live key is refused: this demo never charges a card.
const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/;
export const isTestKey = (key: string) => TEST_KEY.test(key);

let cached: { key: string; stripe: Stripe } | undefined;

/** The client, or null without a usable key. Neither the key nor any part of it is ever logged. */
export function stripeOrNull(): Stripe | null {
  let key: string;
  try {
    key = stripeSecretKey();
  } catch (err) {
    if (err instanceof MissingEnvError) return null;
    throw err;
  }
  if (!isTestKey(key)) {
    console.error('[billing] STRIPE_SECRET_KEY is not a test-mode key, so Stripe calls are off');
    return null;
  }
  if (cached?.key !== key) cached = { key, stripe: new Stripe(key, { maxNetworkRetries: 2, timeout: 10_000, telemetry: false }) };
  return cached.stripe;
}

export function requireStripe(): Stripe {
  const stripe = stripeOrNull();
  if (!stripe) throw new ApiError(503, 'checkout_not_configured', 'Upgrading isn’t set up on this server yet. Searches you have left still work.');
  return stripe;
}

/**
 * A Stripe failure as an answer the recruiter can act on, instead of an unhandled 500. `known`
 * names the failures that mean something more specific than "try again".
 */
export async function stripeCall<T>(what: string, fn: () => Promise<T>, known?: (err: Stripe.errors.StripeError) => ApiError | undefined): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof Stripe.errors.StripeError)) throw err;
    // The type and code only: a Stripe message can quote request parameters.
    console.error(`[billing] ${what} failed: ${err.type}${err.code ? ` (${err.code})` : ''}`);
    throw known?.(err) ?? new ApiError(502, 'stripe_unavailable', 'Couldn’t reach Stripe just now. Try again in a moment.');
  }
}
