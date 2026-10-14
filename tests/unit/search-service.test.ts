// lib/server/search-service.ts: a search is reserve → model → complete, the reservation is given
// back whenever the search can't complete, and nothing reaches the model or the quota before the
// input is valid. The database is a stub that records the RPCs it receives.
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Recruiter } from '@/lib/server/auth';
import { ApiError } from '@/lib/server/http';
import { LlmConfigError, LlmUnavailableError } from '@/lib/server/search/parse-brief';
import { interpretBrief } from '@/lib/server/search/pipeline';
import { newSearch, refineSearch } from '@/lib/server/search-service';
import { DbError } from '@/lib/server/supabase';

vi.mock('@/lib/server/search/pipeline', () => ({ interpretBrief: vi.fn() }));
const interpret = vi.mocked(interpretBrief);

const SEARCH_ID = '0d3c2d9e-5b1a-4c4f-9e2a-1b2c3d4e5f60';
const FILTERS = { roles: ['Backend Engineer'], cities: ['Austin'] };
const PAGE_ONE = { search_id: SEARCH_ID, brief: 'backend engineers in Austin', filters: FILTERS, page: 1, per_page: 20, total: 0, results: [], searches_remaining: 0 };

type Rpc = { fn: string; args: Record<string, unknown> };
type Reply = { data: unknown; error: { code: string; message: string } | null };

let calls: Rpc[];
let replies: Partial<Record<string, Reply>>;

function recruiter(): Recruiter {
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ fn, args });
    return replies[fn] ?? { data: null, error: null };
  };
  return { db: { rpc } as unknown as SupabaseClient, userId: 'u', companyId: 'c', email: null };
}

const interpretation = (filters: object) => ({ filters, outcome: 'ok' as const, conversions: [], notes: [], llm: { ms: 1, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } });

beforeEach(() => {
  calls = [];
  replies = { reserve_search: { data: SEARCH_ID, error: null }, complete_search: { data: PAGE_ONE, error: null } };
  interpret.mockReset();
});

const names = () => calls.map((c) => c.fn);

describe('newSearch', () => {
  it('reserves, interprets, completes, and returns exactly the five contract keys', async () => {
    interpret.mockResolvedValue(interpretation(FILTERS));
    const res = await newSearch(recruiter(), 'backend engineers in Austin');
    expect(names()).toEqual(['reserve_search', 'complete_search']);
    expect(calls[0]?.args).toEqual({ p_brief: 'backend engineers in Austin', p_source: 'brief' });
    expect(calls[1]?.args).toEqual({ p_search_id: SEARCH_ID, p_filters: FILTERS });
    expect(Object.keys(res).sort()).toEqual(['filters', 'results', 'search_id', 'searches_remaining', 'total']);
  });

  it('a 402 from reserve never reaches the model', async () => {
    replies.reserve_search = { data: null, error: { code: 'P0402', message: 'used' } };
    await expect(newSearch(recruiter(), 'x')).rejects.toMatchObject(new DbError('P0402', 'used'));
    expect(interpret).not.toHaveBeenCalled();
    expect(names()).toEqual(['reserve_search']);
  });

  it('model unavailable → 503 and the search is given back', async () => {
    interpret.mockRejectedValue(new LlmUnavailableError('timeout'));
    const err = await newSearch(recruiter(), 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect(calls.map((c) => [c.fn, c.args])).toEqual([
      ['reserve_search', { p_brief: 'x', p_source: 'brief' }],
      ['release_search', { p_search_id: SEARCH_ID }],
    ]);
  });

  it('model key rejected → 500 and the search is given back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    interpret.mockRejectedValue(new LlmConfigError('401'));
    const err = await newSearch(recruiter(), 'x').catch((e: unknown) => e);
    expect([(err as ApiError).status, (err as ApiError).code]).toEqual([500, 'model_not_configured']);
    expect(names()).toEqual(['reserve_search', 'release_search']);
  });

  it('a failed complete gives the search back and rethrows', async () => {
    interpret.mockResolvedValue(interpretation(FILTERS));
    replies.complete_search = { data: null, error: { code: '23514', message: 'bad filters' } };
    await expect(newSearch(recruiter(), 'x')).rejects.toMatchObject({ code: '23514' });
    expect(names()).toEqual(['reserve_search', 'complete_search', 'release_search']);
  });

  it('a failed release is logged, and the original error still wins', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    interpret.mockRejectedValue(new LlmUnavailableError('timeout'));
    replies.release_search = { data: null, error: { code: '42501', message: 'gone' } };
    await expect(newSearch(recruiter(), 'x')).rejects.toMatchObject({ status: 503 });
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('refineSearch', () => {
  it('invalid filters are a 400 before any reservation (400 before 402)', async () => {
    const err = await refineSearch(recruiter(), { brief: 'x', filters: { roles: ['Wizard'] }, source: 'edit' }).catch((e: unknown) => e);
    expect([(err as ApiError).status, (err as ApiError).code]).toEqual([400, 'invalid_filters']);
    expect(calls).toEqual([]);
  });

  it.each([[undefined], [null], [[]], ['roles'], [{ role: ['Backend Engineer'] }]])('rejects %j', async (filters) => {
    await expect(refineSearch(recruiter(), { brief: 'x', filters, source: 'edit' })).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });

  it('normalises the filters and never calls the model', async () => {
    await refineSearch(recruiter(), { brief: 'x', filters: { cities: ['Austin'], roles: ['Backend Engineer', 'Backend Engineer'], skills_any: [] }, source: 'saved' });
    expect(interpret).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { fn: 'reserve_search', args: { p_brief: 'x', p_source: 'saved' } },
      { fn: 'complete_search', args: { p_search_id: SEARCH_ID, p_filters: { roles: ['Backend Engineer'], cities: ['Austin'] } } },
    ]);
  });
});
