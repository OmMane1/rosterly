// Direct Postgres access for integration tests. Tests touch only their own rows: most run inside
// `inRollback`, so nothing they write survives the test.
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// Local Supabase's fixed URL ([db] port in supabase/config.toml); .env.local overrides it.
const LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** A client inside an open transaction. */
export type Tx = pg.PoolClient;

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL, max: 10 });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Runs `fn` in a transaction that is always rolled back. */
export async function inRollback<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('begin');
    return await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/**
 * Runs one statement inside a savepoint and returns the SQLSTATE it failed with, or null if it
 * succeeded. The surrounding transaction stays usable either way.
 */
export async function sqlState(client: pg.PoolClient, text: string, values?: unknown[]): Promise<string | null> {
  await client.query('savepoint probe');
  try {
    await client.query(text, values);
    await client.query('release savepoint probe');
    return null;
  } catch (err) {
    await client.query('rollback to savepoint probe');
    if (err instanceof pg.DatabaseError) return err.code ?? 'unknown';
    throw err;
  }
}

// ---- fixtures (call inside inRollback) ----

export async function createCompany(client: pg.PoolClient): Promise<string> {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const { rows } = await client.query<{ id: string }>('insert into public.companies (slug, name) values ($1, $1) returning id', [slug]);
  const [row] = rows;
  if (!row) throw new Error('company insert returned no row');
  return row.id;
}

export async function createRecruiter(client: pg.PoolClient, companyId: string): Promise<string> {
  const userId = randomUUID();
  await client.query('insert into auth.users (id, email) values ($1, $2)', [userId, `${userId}@test.invalid`]);
  await client.query('insert into public.recruiters (user_id, company_id) values ($1, $2)', [userId, companyId]);
  return userId;
}

/** Makes auth.uid() return `userId` for the rest of the transaction, as PostgREST does per request. */
export async function actAs(client: pg.PoolClient, userId: string): Promise<void> {
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: 'authenticated' })]);
}

export async function createCandidate(client: pg.PoolClient, overrides: { seniority?: string } = {}): Promise<string> {
  const id = `test_${randomUUID().slice(0, 8)}`;
  await client.query(
    `insert into public.candidates (id, full_name, avatar_url, headline, current_title, current_company,
       current_company_logo_url, role, seniority, years_experience, city, state, country, open_to_work, skills)
     values ($1, 'Test Person', 'https://example.test/a.svg', 'Test', 'Backend Engineer', 'Fizzbit',
       'https://example.test/l.svg', 'Backend Engineer', $2, 4, 'Denver', 'CO', 'US', true, '{Go}')`,
    [id, overrides.seniority ?? 'mid'],
  );
  return id;
}
