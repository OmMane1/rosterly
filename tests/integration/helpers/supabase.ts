// supabase-js clients for integration tests, configured from .env.local (written by make setup).
// They talk to the real local API (Kong → GoTrue/PostgREST), so RLS and grants apply.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DEMO_PASSWORD } from '@/lib/shared/demo-accounts';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run \`make setup\` (or \`node scripts/write-env.mjs\`) first`);
  return value;
}

const NO_SESSION_STORAGE = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/** A client with only the publishable key: the anon role until it signs in. */
export function publicClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'), NO_SESSION_STORAGE);
}

/** The secret-key client, used only for auth admin calls (creating throwaway users). */
export function adminClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SECRET_KEY'), NO_SESSION_STORAGE);
}

export function supabaseUrl(): string {
  return env('SUPABASE_URL');
}

export function publishableKey(): string {
  return env('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
}

export type Session = { client: SupabaseClient; userId: string; accessToken: string };

/** Signs in with email/password; the returned client sends that user's token on every request. */
export async function signIn(email: string, password: string = DEMO_PASSWORD): Promise<Session> {
  const client = publicClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in as ${email} failed: ${error.message}`);
  return { client, userId: data.user.id, accessToken: data.session.access_token };
}
