import 'server-only';
// Who is calling (PLAN.md § 3.7): no valid Supabase access token → 401; a valid user who isn't a
// recruiter → 403. Checked first in every route, before the body is read (A14: 401 → 403 → 400 → 402).
import { isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';
import { forbidden, unauthorized } from './http';
import { authClient, check, userClient } from './supabase';

export type Recruiter = {
  /** Runs every query as this recruiter, so RLS scopes it to their company. */
  db: SupabaseClient;
  userId: string;
  companyId: string;
  /** From the verified token; null for a user without one. */
  email: string | null;
};

const BEARER = /^Bearer[ \t]+([A-Za-z0-9._~+/=-]+)[ \t]*$/i;

export async function requireRecruiter(req: Request): Promise<Recruiter> {
  const token = BEARER.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!token) throw unauthorized();

  // Local tokens are ES256: getClaims checks the signature and expiry against the auth server's
  // JWKS, fetched once and cached, so this costs ~1 ms instead of a round trip (DECISIONS.md).
  const { data, error } = await authClient().auth.getClaims(token);
  if (error) {
    if (isAuthRetryableFetchError(error)) throw error; // the auth server is down: a 500, not "sign in"
    throw unauthorized();
  }
  const { role, sub, email } = data?.claims ?? {};
  if (role !== 'authenticated' || typeof sub !== 'string') throw unauthorized();

  const db = userClient(token);
  const row = check(await db.from('recruiters').select('company_id').eq('user_id', sub).maybeSingle<{ company_id: string }>());
  if (!row) throw forbidden();
  return { db, userId: sub, companyId: row.company_id, email: typeof email === 'string' ? email : null };
}
