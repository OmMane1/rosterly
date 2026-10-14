import 'server-only';
// The only place API responses are built (CLAUDE.md § Coding conventions). Every error is
// { error: { code, message } }, Postgres error codes map to statuses here and nowhere else, and an
// error nobody anticipated is a 500 that is logged without request data.
import type { ZodType } from 'zod';
import { MAX_PAGE } from '@/lib/shared/api';
import { DbError } from './supabase';

/** Request bodies above this are rejected unread (PLAN.md A14). */
export const MAX_BODY_BYTES = 32 * 1024;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra top-level fields next to `error` (the 402 body). */
    readonly extra?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (code: string, message: string) => new ApiError(400, code, message);
export const unauthorized = () => new ApiError(401, 'unauthorized', 'Sign in to continue.');
export const forbidden = () => new ApiError(403, 'forbidden', 'This account is not a recruiter at any company.');
export const notFound = (message = 'Not found.') => new ApiError(404, 'not_found', message);

// A row of another company is invisible under RLS, so for every lookup "not yours" and "doesn't
// exist" are the same answer: 404, with no hint which one it was.
const POSTGRES: Record<string, () => ApiError> = {
  '22P02': () => notFound(), // a malformed id (not a uuid) names nothing
  '23503': () => notFound(), // the list or the person isn't there for this company
  '42501': () => notFound(), // RLS, or "no such search for your company" from the SQL functions
  '23514': () => badRequest('invalid_request', 'The request breaks a data rule.'),
  P0402: () =>
    new ApiError(402, 'search_limit_reached', 'The free plan includes 1 search, and it has been used. Upgrade to keep searching; paging is always free.', {
      // reserve_search raises P0402 only on the free plan with nothing left.
      plan: 'free',
      searches_remaining: 0,
    }),
  // reserve_search's per-recruiter pace; the minute window is the one a burst runs into.
  P0429: () => new ApiError(429, 'rate_limited', 'Too many searches at once. Wait a minute and try again; this did not use a search.', undefined, { 'Retry-After': '60' }),
  // PostgREST rejecting the token (e.g. it expired after we verified it).
  PGRST301: unauthorized,
  PGRST302: unauthorized,
  PGRST303: unauthorized,
};

export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers: { ...headers, 'Cache-Control': 'no-store' } });
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof DbError) {
    const mapped = POSTGRES[err.code];
    if (mapped) return mapped();
  }
  // Name, code and message only: never the request, its headers or its token.
  const code = err instanceof DbError ? ` (${err.code})` : '';
  console.error(`[api] unhandled ${err instanceof Error ? `${err.name}${code}: ${err.message}` : typeof err}`);
  return new ApiError(500, 'internal', 'Something went wrong on our side. Try again.');
}

export function errorResponse(err: unknown): Response {
  const e = toApiError(err);
  return json({ error: { code: e.code, message: e.message }, ...e.extra }, e.status, e.headers);
}

/** Wraps a route handler so anything it throws becomes the right error response. */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** The raw body, read at most `maxBytes`; a larger one is a 400. */
export async function readBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
  const tooLarge = () => badRequest('body_too_large', `The request body must be at most ${maxBytes / 1024} KB.`);
  const declared = Number(req.headers.get('content-length'));
  if (declared > maxBytes) throw tooLarge();

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  for (;;) {
    const chunk = await reader?.read();
    if (!chunk || chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader?.cancel();
      throw tooLarge();
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}

/** The body as a JSON object, read at most MAX_BODY_BYTES; anything else is a 400. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw badRequest('invalid_json', 'The request body must be JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('invalid_body', 'The request body must be a JSON object.');
  return body as Record<string, unknown>;
}

/** `schema.parse`, with the first problem as a 400 the recruiter can read. */
export function parseInput<T>(schema: ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw badRequest(code, `${where}${issue?.message ?? 'Invalid input.'}`);
}

/** `?page=N`: absent means 1; anything but a whole number from 1 to 10,000 is a 400 (PLAN.md A10). */
export function pageParam(req: Request): number {
  const raw = new URL(req.url).searchParams.get('page');
  if (raw === null) return 1;
  const page = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(page >= 1 && page <= MAX_PAGE)) throw badRequest('invalid_page', `page must be a whole number from 1 to ${MAX_PAGE}.`);
  return page;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id that must be a uuid; anything else names nothing, so it is a 404 like an unknown id. */
export function uuidParam(value: string, what: string): string {
  if (!UUID.test(value)) throw notFound(`${what} not found.`);
  return value.toLowerCase();
}
