// The API contract in zod (PLAN.md § 3.7): request bodies the routes accept and the response
// shapes they return. Shared so the UI (M9) reads exactly what the server sends.
import { z } from 'zod';
import { Brief } from './brief';
import { MAX_FILTERS_BYTES, type Filters } from './filters';
import { sanitizeDeep, sanitizeText } from './sanitize';

export const PER_PAGE = 20;
export const MAX_PAGE = 10_000;
export const MAX_SHORTLIST_NAME = 80;

export const isJsonObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

// ---- requests ----

export const SearchRequest = z.object({ brief: Brief });

/**
 * Chip edits and saved re-runs. `filters` (missing included) is checked against the canonical
 * schema by the search service, so every filters problem is one `invalid_filters` 400.
 */
export const RefineRequest = z.object({ brief: Brief, filters: z.unknown().optional(), source: z.enum(['edit', 'saved']) });

/** One line, 1–80 characters; runs of whitespace (a pasted newline) become one space. */
export const ShortlistName = z
  .string()
  .transform((s) => sanitizeText(s).replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1, 'Name the list.')
      .refine((s) => [...s].length <= MAX_SHORTLIST_NAME, `Keep the name under ${MAX_SHORTLIST_NAME} characters.`),
  );
export const ShortlistRequest = z.object({ name: ShortlistName });

/** Any JSON object up to 16 KB (PLAN.md A12); it is checked against `Filters` only when re-run. */
export const SavedFilters = z
  .unknown()
  .transform(sanitizeDeep)
  .pipe(z.custom<Record<string, unknown>>(isJsonObject, 'filters must be a JSON object'))
  .refine((f) => jsonBytes(f) <= MAX_FILTERS_BYTES, `filters must be at most ${MAX_FILTERS_BYTES} bytes as JSON`);
export const SavedBriefRequest = z.object({ brief: Brief, filters: SavedFilters });

// ---- responses ----

export const Location = z.object({ city: z.string(), state: z.string(), country: z.string() });

/** A candidate in a result list or a shortlist: the candidates.json fields a card shows. */
export const Card = z.object({
  id: z.string(),
  full_name: z.string(),
  avatar_url: z.string(),
  headline: z.string(),
  current_title: z.string(),
  current_company: z.string(),
  current_company_logo_url: z.string(),
  role: z.string(),
  seniority: z.string(),
  years_experience: z.number(),
  location: Location,
  open_to_work: z.boolean(),
  skills: z.array(z.string()),
});
export type Card = z.infer<typeof Card>;

export const Experience = z.object({
  title: z.string(),
  company: z.string(),
  company_logo_url: z.string(),
  company_type: z.string(),
  start_year: z.number(),
  end_year: z.number().nullable(),
  description: z.string(),
});
export const Education = z.object({ school: z.string(), degree: z.string(), field: z.string(), graduation_year: z.number() });

/** One candidate in the candidates.json shape. */
export const Person = Card.extend({ experiences: z.array(Experience), education: z.array(Education) });
export type Person = z.infer<typeof Person>;

// Stored filters were valid when saved; re-checking them against today's vocabulary on every read
// would turn a vocabulary change into failing pages, so reads only require an object.
const StoredFilters = z.custom<Filters>(isJsonObject, 'filters must be an object');

export const SearchPage = z.object({
  search_id: z.string(),
  brief: z.string(),
  filters: StoredFilters,
  page: z.number(),
  per_page: z.number(),
  total: z.number(),
  results: z.array(Card),
});
export type SearchPage = z.infer<typeof SearchPage>;

/** POST /api/search and /api/search/refine: exactly these five keys (PLAN.md § 3.7). */
export const SearchResponse = SearchPage.pick({ search_id: true, filters: true, total: true, results: true }).extend({
  searches_remaining: z.number().nullable(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

/**
 * GET /api/search/{id}/broader: for a search that found no one, how many people each one-step
 * relaxation (a chip key, or "unsupported" for all warnings) would find, most first.
 */
export const Broader = z.object({ options: z.array(z.object({ key: z.string(), total: z.number() })) });
export type Broader = z.infer<typeof Broader>;

/** POST /api/billing/checkout and /api/billing/portal: the Stripe page to send the browser to. */
export const StripeRedirect = z.object({ url: z.url() });
export type StripeRedirect = z.infer<typeof StripeRedirect>;

export const Plan = z.object({ plan: z.enum(['free', 'paid']), searches_remaining: z.number().nullable() });
export type Plan = z.infer<typeof Plan>;

export const Shortlist = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  people_count: z.number(),
  people: z.array(Card),
});
export type Shortlist = z.infer<typeof Shortlist>;

export const SavedBrief = z.object({
  id: z.string(),
  brief: z.string(),
  filters: z.custom<Record<string, unknown>>(isJsonObject),
  created_at: z.string(),
});
export type SavedBrief = z.infer<typeof SavedBrief>;

export type Created = { id: string };
export type Ok = { ok: true };
export type ApiErrorBody = { error: { code: string; message: string } };

/** GET /api/me: who is signed in and for which company (the header shows the company name). */
export const Me = z.object({ email: z.string().nullable(), company: z.object({ slug: z.string(), name: z.string() }) });
export type Me = z.infer<typeof Me>;
