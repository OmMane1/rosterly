// Typed calls to our own API (PLAN.md § 3.7) as the signed-in recruiter. Responses are parsed with
// the same zod shapes the server sends, and every failure becomes an ApiError with the server's
// code and message, so the UI can tell a 402 from a 503 without guessing.
import { z, type ZodType } from 'zod';
import { Broader, Me, Person, Plan, SavedBrief, SearchPage, SearchResponse, Shortlist, StripeRedirect } from '@/lib/shared/api';
import type { Filters } from '@/lib/shared/filters';
import { accessToken } from './supabase';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const isApiError = (err: unknown, status?: number): err is ApiError => err instanceof ApiError && (status === undefined || err.status === status);

const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const Created = z.object({ id: z.string() });
const Ok = z.object({ ok: z.literal(true) });
const Renamed = z.object({ id: z.string(), name: z.string() });

async function request<T>(method: string, path: string, schema: ZodType<T>, body?: unknown): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'network', 'Couldn’t reach Rosterly. Check your connection and try again.');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = ErrorBody.safeParse(data);
    throw new ApiError(res.status, e.success ? e.data.error.code : `http_${res.status}`, e.success ? e.data.error.message : 'Something went wrong. Try again.');
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(res.status, 'bad_response', 'The server sent something unexpected. Try again.');
  return parsed.data;
}

const id = (v: string) => encodeURIComponent(v);

export const api = {
  me: () => request('GET', '/api/me', Me),
  plan: () => request('GET', '/api/plan', Plan),
  checkout: () => request('POST', '/api/billing/checkout', StripeRedirect),
  billingPortal: () => request('POST', '/api/billing/portal', StripeRedirect),

  search: (brief: string) => request('POST', '/api/search', SearchResponse, { brief }),
  refine: (brief: string, filters: Filters | Record<string, unknown>, source: 'edit' | 'saved') =>
    request('POST', '/api/search/refine', SearchResponse, { brief, filters, source }),
  searchPage: (searchId: string, page: number) => request('GET', `/api/search/${id(searchId)}?page=${page}`, SearchPage),
  broader: (searchId: string) => request('GET', `/api/search/${id(searchId)}/broader`, Broader),

  person: (personId: string) => request('GET', `/api/people/${id(personId)}`, Person),

  shortlists: () => request('GET', '/api/shortlists', z.array(Shortlist)),
  shortlist: (listId: string) => request('GET', `/api/shortlists/${id(listId)}`, Shortlist),
  createShortlist: (name: string) => request('POST', '/api/shortlists', Created, { name }),
  renameShortlist: (listId: string, name: string) => request('PATCH', `/api/shortlists/${id(listId)}`, Renamed, { name }),
  deleteShortlist: (listId: string) => request('DELETE', `/api/shortlists/${id(listId)}`, Ok),
  addToShortlist: (listId: string, personId: string) => request('POST', `/api/shortlists/${id(listId)}/people/${id(personId)}`, Ok),
  removeFromShortlist: (listId: string, personId: string) => request('DELETE', `/api/shortlists/${id(listId)}/people/${id(personId)}`, Ok),

  savedBriefs: () => request('GET', '/api/saved-briefs', z.array(SavedBrief)),
  saveBrief: (brief: string, filters: Filters) => request('POST', '/api/saved-briefs', Created, { brief, filters }),
  deleteSavedBrief: (savedId: string) => request('DELETE', `/api/saved-briefs/${id(savedId)}`, Ok),
};
