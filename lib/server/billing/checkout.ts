import 'server-only';
// Upgrade and Manage billing (PLAN.md § 3.6): Stripe's hosted pages, in test mode. Neither one
// changes the plan. Stripe's signed webhook does, so coming back from Checkout early, or twice,
// changes nothing.
import Stripe from 'stripe';
import { PAID_PLAN } from '@/lib/shared/billing';
import type { Recruiter } from '../auth';
import { ApiError, notFound } from '../http';
import { getPlan } from '../plan';
import { check } from '../supabase';
import { requireStripe, stripeCall } from './stripe';

export type CheckoutInput = { slug: string; companyName: string; email: string | null; customer: string | null; price: string; origin: string };

/**
 * One company's Checkout Session. metadata.company on the session and on its subscription is how
 * the webhook finds the company (apply_stripe_event resolves the slug).
 */
export function checkoutParams(i: CheckoutInput): Stripe.Checkout.SessionCreateParams {
  return {
    mode: 'subscription',
    line_items: [{ price: i.price, quantity: 1 }],
    client_reference_id: i.slug,
    metadata: { company: i.slug },
    subscription_data: { metadata: { company: i.slug }, description: `${PAID_PLAN.name} for ${i.companyName}` },
    // The company's earlier Stripe customer, so its billing history stays in one place.
    ...(i.customer ? { customer: i.customer } : i.email ? { customer_email: i.email } : {}),
    success_url: `${i.origin}/?upgrade=done`,
    cancel_url: `${i.origin}/?upgrade=cancelled`,
  };
}

let price: Promise<string> | undefined;

/**
 * The one recurring price, found by its lookup key or created the first time. Creating it inline
 * in every session would leave a new product in the dashboard each time Checkout opens.
 */
function paidPrice(stripe: Stripe): Promise<string> {
  const find = async () => (await stripe.prices.list({ lookup_keys: [PAID_PLAN.lookupKey], active: true, limit: 1 })).data[0]?.id;
  price ??= (async () => {
    const existing = await find();
    if (existing) return existing;
    try {
      const created = await stripe.prices.create({
        lookup_key: PAID_PLAN.lookupKey,
        currency: PAID_PLAN.currency,
        unit_amount: PAID_PLAN.amount,
        recurring: { interval: PAID_PLAN.interval },
        product_data: { name: PAID_PLAN.name },
      });
      return created.id;
    } catch (err) {
      // Another instance created it first: a lookup key is unique, so the price is there now.
      const raced = await find();
      if (raced) return raced;
      throw err;
    }
  })().catch((err: unknown) => {
    price = undefined;
    throw err;
  });
  return price;
}

/** The customer of the company's most recent subscription, if Stripe ever sent one. */
async function latestCustomer(r: Recruiter): Promise<string | null> {
  const row = check(
    await r.db.from('subscriptions').select('customer').not('customer', 'is', null).order('updated_at', { ascending: false }).limit(1).maybeSingle<{ customer: string }>(),
  );
  return row?.customer ?? null;
}

/** POST /api/billing/checkout: the URL of a Checkout page for the recruiter's company. */
export async function createCheckout(r: Recruiter, origin: string): Promise<{ url: string }> {
  if ((await getPlan(r)).plan === 'paid') throw new ApiError(409, 'already_paid', 'Your company is already on Paid.');
  const stripe = requireStripe();
  const company = check(await r.db.from('companies').select('slug,name').eq('id', r.companyId).single<{ slug: string; name: string }>());
  const customer = await latestCustomer(r);
  const session = await stripeCall('creating a Checkout Session', async () =>
    stripe.checkout.sessions.create(checkoutParams({ slug: company.slug, companyName: company.name, email: r.email, customer, price: await paidPrice(stripe), origin })),
  );
  if (!session.url) throw new Error('Stripe returned a Checkout Session without a URL');
  return { url: session.url };
}

/** POST /api/billing/portal: the URL of Stripe's billing portal for the company's customer. */
export async function createPortal(r: Recruiter, origin: string): Promise<{ url: string }> {
  const customer = await latestCustomer(r);
  if (!customer) throw notFound('This company has no Stripe billing yet. Its plan didn’t come from Checkout.');
  const stripe = requireStripe();
  const session = await stripeCall(
    'creating a billing portal session',
    () => stripe.billingPortal.sessions.create({ customer, return_url: `${origin}/` }),
    // Test mode has no portal until its settings are saved once in the Stripe dashboard.
    (err) =>
      err.type === 'StripeInvalidRequestError' && /configuration/i.test(err.message)
        ? new ApiError(503, 'portal_not_configured', 'Stripe’s billing page isn’t set up for this demo yet.')
        : undefined,
  );
  return { url: session.url };
}
