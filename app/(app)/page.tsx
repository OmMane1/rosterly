'use client';
// Search (PLAN.md § 3.9). The search on screen lives in the URL (?s=<id>&page=N), so refresh, back
// and shared links show the same frozen results. Chip edits are staged behind the Apply bar on the
// free plan, where each new result set uses the one search; on Paid they apply at once
// (DECISIONS.md). Paging is never a new search.
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { SearchX } from 'lucide-react';
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CandidateListSkeleton } from '@/components/candidates/candidate-card';
import { useUpgrade } from '@/components/plan/upgrade';
import { ApplyBar } from '@/components/search/apply-bar';
import { BriefForm } from '@/components/search/brief-form';
import { ExampleBriefs } from '@/components/search/example-briefs';
import { FilterBar } from '@/components/search/filter-bar';
import { NoResults, parsePage, Results, searchHref } from '@/components/search/results';
import { ErrorBanner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { api, isApiError } from '@/lib/client/api';
import { useNewSearch, useRefine } from '@/lib/client/hooks/mutations';
import { keys, usePlan, useSearchPage } from '@/lib/client/hooks/queries';
import { rememberScroll, takeScroll } from '@/lib/client/navigation';
import { PER_PAGE } from '@/lib/shared/api';
import { countChanges } from '@/lib/shared/chips';
import { hasSubstantiveFilter, type Filters } from '@/lib/shared/filters';

export default function SearchRoute() {
  return (
    <Suspense fallback={<ResultsSkeleton />}>
      <SearchScreen />
    </Suspense>
  );
}

function SearchScreen() {
  const params = useSearchParams();
  const s = params.get('s');
  const page = parsePage(params.get('page'));
  const router = useRouter();
  const qc = useQueryClient();
  const plan = usePlan();
  const openUpgrade = useUpgrade();
  const toast = useToast();
  const result = useSearchPage(s, page);
  const newSearch = useNewSearch();
  const refine = useRefine();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // The brief box follows the search on screen until the recruiter types; drafts belong to one search.
  const [edit, setEdit] = useState<{ key: string; text: string } | null>(null);
  const text = edit?.key === (s ?? '') ? edit.text : (result.data?.brief ?? '');
  const setText = (t: string) => setEdit({ key: s ?? '', text: t });
  const [draftState, setDraftState] = useState<{ key: string; filters: Filters } | null>(null);
  const draft = s && draftState?.key === s ? draftState.filters : null;
  const stage = (filters: Filters) => s && setDraftState({ key: s, filters });

  const paid = plan.data?.plan === 'paid';
  const immediate = paid && draft === null;

  /** Free with nothing left (checked against the server, in case Stripe just upgraded us). */
  const outOfSearches = async () => {
    if (plan.data?.plan !== 'free' || (plan.data.searches_remaining ?? 0) > 0) return false;
    const fresh = (await plan.refetch()).data;
    return fresh?.plan !== 'paid' && (fresh?.searches_remaining ?? 0) <= 0;
  };

  const runBrief = async (brief: string) => {
    if (!brief.trim()) return;
    if (await outOfSearches()) return openUpgrade({ reason: 'limit', retry: () => void runBrief(brief) });
    newSearch.mutate(brief.trim(), {
      onSuccess: (res) => router.push(searchHref(res.search_id)),
      onError: (err) => isApiError(err, 402) && openUpgrade({ reason: 'limit', retry: () => void runBrief(brief) }),
    });
  };

  const applyFilters = async (filters: Filters) => {
    const current = result.data;
    if (!current) return;
    if (await outOfSearches()) {
      stage(filters);
      return openUpgrade({ reason: 'limit', retry: () => void applyFilters(filters) });
    }
    refine.mutate(
      { brief: current.brief, filters, source: 'edit' },
      {
        onSuccess: (res) => {
          setDraftState(null);
          router.push(searchHref(res.search_id));
        },
        onError: (err) => {
          stage(filters); // keep the edit, so Apply can try again
          if (isApiError(err, 402)) openUpgrade({ reason: 'limit', retry: () => void applyFilters(filters) });
          else toast({ tone: 'error', title: err.message });
        },
      },
    );
  };

  const onChange = (next: Filters) => {
    if (!result.data) return;
    if (countChanges(result.data.filters, next) === 0) return setDraftState(null);
    if (immediate) return void applyFilters(next);
    stage(next);
  };

  // Back from a candidate: same page, same spot. A new page: start at its first result.
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!result.data || !s) return;
    const key = `${s}:${page}`;
    const previous = shown.current;
    shown.current = key;
    const y = takeScroll(key);
    if (y !== null) window.scrollTo(0, y);
    else if (previous?.startsWith(`${s}:`) && previous !== key) {
      headingRef.current?.scrollIntoView({ block: 'start' });
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [result.data, s, page]);

  // The next page is usually wanted; fetch it ahead so paging feels instant.
  const total = result.data?.total ?? 0;
  useEffect(() => {
    if (s && page * PER_PAGE < total) void qc.prefetchQuery({ queryKey: keys.search(s, page + 1), queryFn: () => api.searchPage(s, page + 1), staleTime: Infinity });
  }, [qc, s, page, total]);

  const searchError = newSearch.error;
  const fieldError = isApiError(searchError, 400) ? searchError.message : null;
  const bannerError = searchError && !isApiError(searchError, 400) && !isApiError(searchError, 402) ? searchError : null;
  const hero = !s && !newSearch.isPending;

  return (
    <div className="mx-auto max-w-3xl">
      {hero ? (
        <header className="mb-6 sm:mb-8 md:pt-6">
          <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-[34px]">Who are you looking for?</h1>
          <p className="mt-2 max-w-xl text-[15px] text-pretty text-stone-600">
            Describe them in plain English. Rosterly turns your brief into filters you can check and adjust, then finds everyone who fits.
          </p>
        </header>
      ) : (
        <h1 className="sr-only">Search</h1>
      )}

      <BriefForm value={text} onChange={setText} onSubmit={() => void runBrief(text)} pending={newSearch.isPending} error={fieldError} large={hero} inputRef={inputRef} />

      {bannerError && (
        <ErrorBanner className="mt-4" title={isApiError(bannerError, 503) ? 'Search is busy for a moment' : 'The search didn’t go through'} onRetry={() => void runBrief(newSearch.variables ?? text)}>
          {bannerError.message}
        </ErrorBanner>
      )}

      {newSearch.isPending ? (
        <Searching />
      ) : !s ? (
        <ExampleBriefs
          onPick={(b) => {
            setText(b);
            inputRef.current?.focus();
          }}
        />
      ) : result.isPending ? (
        <ResultsSkeleton />
      ) : result.isError ? (
        isApiError(result.error, 404) ? (
          <EmptyState
            icon={SearchX}
            title="This search isn’t available"
            className="mt-6"
            actions={
              <Button asChild variant="secondary">
                <Link href="/">Start a new search</Link>
              </Button>
            }
          >
            It may belong to another company, or the link is incomplete.
          </EmptyState>
        ) : (
          <ErrorBanner className="mt-6" title="Couldn’t load these results" onRetry={() => result.refetch()} retrying={result.isFetching}>
            {result.error.message} Loading results never uses a search.
          </ErrorBanner>
        )
      ) : (
        <div className="mt-6">
          <FilterBar brief={result.data.brief} applied={result.data.filters} draft={draft} onChange={onChange} immediate={immediate} busy={refine.isPending} />
          {refine.isPending && (
            <p role="status" className="mt-4 flex items-center gap-2 text-sm text-stone-600">
              <Spinner /> Updating results…
            </p>
          )}
          <Results
            data={result.data}
            stale={draft !== null}
            busy={refine.isPending}
            onOpenPerson={() => rememberScroll(`${s}:${page}`)}
            headingRef={(el) => {
              headingRef.current = el;
            }}
            empty={
              <NoResults
                searchId={result.data.search_id}
                filters={result.data.filters}
                pending={refine.isPending}
                onApply={(f) => void applyFilters(f)}
                onEditBrief={() => inputRef.current?.focus()}
              />
            }
          />
          {draft && <div aria-hidden className="h-24" />}
        </div>
      )}

      {draft && result.data && (
        <ApplyBar
          count={countChanges(result.data.filters, draft)}
          canApply={hasSubstantiveFilter(draft) || (draft.unsupported?.length ?? 0) > 0}
          pending={refine.isPending}
          onApply={() => void applyFilters(draft)}
          onDiscard={() => setDraftState(null)}
        />
      )}
    </div>
  );
}

function Searching() {
  return (
    <div className="mt-6" role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-sm text-stone-600">
        <Spinner /> Reading your brief and finding everyone who fits…
      </p>
      <div className="mt-4 flex flex-wrap gap-2" aria-hidden>
        <Skeleton className="h-8 w-20 rounded-full" />
        <Skeleton className="h-8 w-36 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
      </div>
      <div className="mt-7">
        <CandidateListSkeleton count={3} />
      </div>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="mt-6" aria-busy="true" aria-label="Loading results">
      <Skeleton className="h-3 w-24" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Skeleton className="h-8 w-20 rounded-full" />
        <Skeleton className="h-8 w-36 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
      </div>
      <Skeleton className="mt-8 h-5 w-28" />
      <div className="mt-3">
        <CandidateListSkeleton />
      </div>
    </div>
  );
}
