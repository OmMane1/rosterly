import 'server-only';
// supabase-js clients for the API. Every query runs as the signed-in recruiter (the publishable key
// plus their own token), so PostgREST applies RLS and the grants (CLAUDE.md § Security rules). The
// secret key is never used here.
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { supabasePublishableKey, supabaseUrl } from './env';

export const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

/** A Postgres or PostgREST error, carrying its code for lib/server/http.ts to map. */
export class DbError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DbError';
  }
}

/** A client that sends the recruiter's token on every request. One per request. */
export function userClient(token: string): SupabaseClient {
  return createClient(supabaseUrl(), supabasePublishableKey(), {
    auth: NO_SESSION,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

let verifier: SupabaseClient | undefined;

/** Used only to verify access tokens; it never holds a session, so one per process is safe. */
export function authClient(): SupabaseClient {
  verifier ??= createClient(supabaseUrl(), supabasePublishableKey(), { auth: NO_SESSION });
  return verifier;
}

/** The data of a supabase-js result, or a DbError. */
export function check<T>(result: { data: T; error: null } | { data: unknown; error: PostgrestError }): T {
  if (result.error) throw new DbError(result.error.code, result.error.message);
  return result.data;
}
