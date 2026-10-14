import 'server-only';
// Server configuration, read lazily inside the functions that need it, never at module load, so
// `next build` works without the model key or the webhook secret (CLAUDE.md § Coding conventions).
import { z } from 'zod';

/** Thrown when a required variable is unset; the message names the variable, never its value. */
export class MissingEnvError extends Error {
  constructor(readonly variable: string) {
    super(`${variable} is not set`);
    this.name = 'MissingEnvError';
  }
}

const Value = z.string().trim().min(1);

function required(name: string): string {
  const parsed = Value.safeParse(process.env[name]);
  if (!parsed.success) throw new MissingEnvError(name);
  return parsed.data;
}

export const anthropicApiKey = () => required('ANTHROPIC_API_KEY');
export const stripeWebhookSecret = () => required('STRIPE_WEBHOOK_SECRET');
export const stripeSecretKey = () => required('STRIPE_SECRET_KEY');
export const supabaseUrl = () => required('SUPABASE_URL');
export const supabasePublishableKey = () => required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
export const supabaseSecretKey = () => required('SUPABASE_SECRET_KEY');
