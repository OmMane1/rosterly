// The browser's Supabase client, used only for signing in and holding the session. It talks to
// /supabase on our own origin (a Next rewrite), so sign-in also works from a phone on the LAN
// (PLAN.md A17). Data comes from /api/*, never from PostgREST directly.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publishableKey } from './env';

let client: SupabaseClient | undefined;

export function supabase(): SupabaseClient {
  client ??= createClient(`${window.location.origin}/supabase`, publishableKey(), {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'rosterly-auth' },
  });
  return client;
}

/** The current access token (refreshed by supabase-js when it is close to expiry), or null. */
export async function accessToken(): Promise<string | null> {
  const { data } = await supabase().auth.getSession();
  return data.session?.access_token ?? null;
}
