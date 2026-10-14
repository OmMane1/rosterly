// A throwaway company with one signed-in recruiter, for tests that change usage or the plan. It
// never touches asterwell's or glenfold's rows; dispose() deletes the company (cascading to its searches,
// lists and subscriptions) and then the auth user.
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { adminClient, signIn, type Session } from './supabase';

/** `email`/`password` let a browser test sign in through the login form. */
type User = Session & { email: string; password: string; dispose: () => Promise<void> };

export type Tenant = User & { companyId: string; slug: string };

/** A signed-in auth user with no recruiter row, plus its cleanup. */
export async function createUser(label: string): Promise<User> {
  const name = `${label}-${randomUUID().slice(0, 8)}`;
  const password = `${name}-password`;
  const { data, error } = await adminClient().auth.admin.createUser({ email: `${name}@tenant.test`, password, email_confirm: true });
  if (error) throw new Error(`creating user ${name} failed: ${error.message}`);
  const session = await signIn(`${name}@tenant.test`, password);
  return {
    ...session,
    email: `${name}@tenant.test`,
    password,
    dispose: async () => {
      await adminClient().auth.admin.deleteUser(data.user.id);
    },
  };
}

export async function createTenant(label: string): Promise<Tenant> {
  const user = await createUser(label);
  const slug = `t-${label}-${randomUUID().slice(0, 8)}`.toLowerCase().slice(0, 40);
  const { rows } = await db().query<{ id: string }>('insert into public.companies (slug, name) values ($1, $1) returning id', [slug]);
  const companyId = rows[0]?.id;
  if (!companyId) throw new Error('company insert returned no row');
  await db().query('insert into public.company_usage (company_id) values ($1)', [companyId]);
  await db().query('insert into public.recruiters (user_id, company_id) values ($1, $2)', [user.userId, companyId]);
  return {
    ...user,
    companyId,
    slug,
    dispose: async () => {
      await db().query('delete from public.companies where id = $1', [companyId]);
      await user.dispose();
    },
  };
}

/** Sets the company's one test subscription to `status`, or removes it (null). */
export async function setSubscription(companyId: string, status: string | null): Promise<void> {
  const id = `sub_test_${companyId}`;
  if (status === null) {
    await db().query('delete from public.subscriptions where stripe_subscription_id = $1', [id]);
    return;
  }
  await db().query(
    `insert into public.subscriptions (stripe_subscription_id, company_id, status, last_event_id, last_event_created, last_event_type)
     values ($1, $2, $3, 'evt_test', 0, 'test')
     on conflict (stripe_subscription_id) do update set status = excluded.status`,
    [id, companyId, status],
  );
}
