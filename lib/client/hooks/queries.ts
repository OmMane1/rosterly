'use client';
// Server state for the signed-in pages (TanStack Query). The plan refetches whenever the window
// regains focus, so an upgrade confirmed by Stripe's webhook shows up without a reload (PLAN.md
// § 3.9). Search pages never change once stored (frozen ranks), so they are cached for good, which
// also makes "back" from a candidate render the same page instantly.
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { Plan, SearchPage, SearchResponse } from '@/lib/shared/api';
import { PER_PAGE } from '@/lib/shared/api';
import { api } from '../api';

export const keys = {
  me: ['me'] as const,
  plan: ['plan'] as const,
  shortlists: ['shortlists'] as const,
  shortlist: (id: string) => ['shortlists', id] as const,
  saved: ['saved-briefs'] as const,
  search: (id: string, page: number) => ['search', id, page] as const,
  person: (id: string) => ['person', id] as const,
};

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: api.me, staleTime: Infinity });

/** `poll` while the Upgrade dialog is open: it watches for the webhook to flip the plan. */
export const usePlan = (poll = false) =>
  useQuery({ queryKey: keys.plan, queryFn: api.plan, staleTime: 0, refetchOnWindowFocus: 'always', refetchInterval: poll ? 3000 : false });

export const useShortlists = () => useQuery({ queryKey: keys.shortlists, queryFn: api.shortlists, staleTime: 30_000 });

export const useShortlist = (id: string) => useQuery({ queryKey: keys.shortlist(id), queryFn: () => api.shortlist(id), staleTime: 30_000 });

export const useSavedBriefs = () => useQuery({ queryKey: keys.saved, queryFn: api.savedBriefs, staleTime: 30_000 });

export const useSearchPage = (id: string | null, page: number) =>
  useQuery({
    queryKey: keys.search(id ?? '', page),
    queryFn: () => api.searchPage(id ?? '', page),
    enabled: id !== null,
    staleTime: Infinity,
    gcTime: 60 * 60_000,
  });

export const usePerson = (id: string) => useQuery({ queryKey: keys.person(id), queryFn: () => api.person(id), staleTime: 5 * 60_000 });

/** A search response is page 1 of that search, and it carries the plan's remaining searches. */
export function rememberSearch(qc: QueryClient, brief: string, res: SearchResponse): void {
  const page: SearchPage = { search_id: res.search_id, brief, filters: res.filters, page: 1, per_page: PER_PAGE, total: res.total, results: res.results };
  qc.setQueryData(keys.search(res.search_id, 1), page);
  qc.setQueryData<Plan>(keys.plan, { plan: res.searches_remaining === null ? 'paid' : 'free', searches_remaining: res.searches_remaining });
}

/** A 402 says the free search is gone; the pill should say so at once. */
export function rememberLimit(qc: QueryClient): void {
  qc.setQueryData<Plan>(keys.plan, { plan: 'free', searches_remaining: 0 });
}
