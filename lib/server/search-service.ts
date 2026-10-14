import 'server-only';
// New searches and paging (PLAN.md § 3.4 steps 3–7, § 3.5). A new result set is
// reserve → (model) → complete, and the reservation is released if anything fails before it
// completes, so only a finished search uses up the free one. Paging reads frozen ranks and never
// touches the quota.
import { z } from 'zod';
import { Broader, SearchPage, SearchResponse, type SearchPage as Page } from '@/lib/shared/api';
import { relaxations } from '@/lib/shared/chips';
import { Filters, normalizeFilters } from '@/lib/shared/filters';
import { sanitizeDeep } from '@/lib/shared/sanitize';
import type { Recruiter } from './auth';
import { ApiError, notFound, parseInput } from './http';
import { LlmConfigError, LlmUnavailableError } from './search/parse-brief';
import { interpretBrief } from './search/pipeline';
import { check } from './supabase';

export type Source = 'brief' | 'edit' | 'saved';

/** Takes one search from the allowance (402 when none is left) and returns the pending search id. */
async function reserve(r: Recruiter, brief: string, source: Source): Promise<string> {
  const id: unknown = check(await r.db.rpc('reserve_search', { p_brief: brief, p_source: source }));
  if (typeof id !== 'string') throw new Error('reserve_search returned no id');
  return id;
}

/** Best effort: a reservation that can't be released is handed back by the next reserve after 2 minutes. */
async function release(r: Recruiter, id: string): Promise<void> {
  try {
    check(await r.db.rpc('release_search', { p_search_id: id }));
  } catch (err) {
    console.error(`[search] release failed: ${err instanceof Error ? err.message : typeof err}`);
  }
}

/** Ranks the matches into search_results and returns page 1 with the plan's remaining searches. */
async function complete(r: Recruiter, id: string, filters: Filters): Promise<SearchResponse> {
  try {
    return SearchResponse.parse(check(await r.db.rpc('complete_search', { p_search_id: id, p_filters: filters })));
  } catch (err) {
    await release(r, id);
    throw err;
  }
}

/** POST /api/search: brief → model → filters → ranked results. */
export async function newSearch(r: Recruiter, brief: string): Promise<SearchResponse> {
  const id = await reserve(r, brief, 'brief');
  let filters: Filters;
  try {
    filters = (await interpretBrief(brief)).filters;
  } catch (err) {
    await release(r, id);
    if (err instanceof LlmUnavailableError) {
      throw new ApiError(503, 'model_unavailable', 'Search is unavailable for a moment. Try again; this did not use a search.');
    }
    if (err instanceof LlmConfigError) {
      console.error(`[search] model call refused: ${err.message}`);
      throw new ApiError(500, 'model_not_configured', 'Search is not configured on this server. This did not use a search.');
    }
    throw err;
  }
  return complete(r, id, filters);
}

/**
 * POST /api/search/refine: the recruiter's own filters (a chip edit or a saved re-run). They are
 * validated against the canonical schema but not grounded: a chip the recruiter picked is meant.
 */
export async function refineSearch(r: Recruiter, input: { brief: string; filters?: unknown; source: Exclude<Source, 'brief'> }): Promise<SearchResponse> {
  const filters = normalizeFilters(parseInput(Filters, sanitizeDeep(input.filters), 'invalid_filters'));
  const id = await reserve(r, input.brief, input.source);
  return complete(r, id, filters);
}

/** GET /api/search/{id}?page=N: 404 for an unknown search or another company's. */
export async function searchPage(r: Recruiter, id: string, page: number): Promise<Page> {
  return SearchPage.parse(check(await r.db.rpc('get_search_page', { p_search_id: id, p_page: page })));
}

/** count_relaxations counts at most this many variants in one call. */
const MAX_RELAXATIONS = 25;

/**
 * GET /api/search/{id}/broader: how many people each one-step relaxation of a search that found no
 * one would find. Reading the counts never uses a search; acting on one is a refine, which does.
 */
export async function broaderOptions(r: Recruiter, id: string): Promise<Broader> {
  const row = check(await r.db.from('searches').select('filters, total').eq('id', id).eq('status', 'done').maybeSingle<{ filters: unknown; total: number }>());
  if (!row) throw notFound('Search not found.');
  if (row.total > 0) return { options: [] };
  // Stored filters were valid when the search ran; one from before a vocabulary change gets no offer.
  const stored = Filters.safeParse(row.filters);
  if (!stored.success) return { options: [] };
  const variants = relaxations(stored.data).slice(0, MAX_RELAXATIONS);
  if (variants.length === 0) return { options: [] };
  const counts = z
    .array(z.number())
    .length(variants.length)
    .parse(check(await r.db.rpc('count_relaxations', { p_search_id: id, p_variants: variants.map((v) => v.filters) })));
  // A stable sort: equal counts keep the chips' order.
  return { options: variants.map((v, i) => ({ key: v.key, total: counts[i] ?? 0 })).sort((a, b) => b.total - a.total) };
}
