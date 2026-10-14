'use client';
// Saved searches: the brief and the filters it was saved with. "Run again" makes a fresh result set
// from those filters (no model call), so it counts as a search on the free plan, and says so.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Play, Search, Star, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useUpgrade } from '@/components/plan/upgrade';
import { CostNote } from '@/components/search/brief-form';
import { searchHref } from '@/components/search/results';
import { ErrorBanner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { isApiError } from '@/lib/client/api';
import { formatDate } from '@/lib/client/format';
import { useDeleteSavedBrief, useRefine } from '@/lib/client/hooks/mutations';
import { usePlan, useSavedBriefs } from '@/lib/client/hooks/queries';
import type { SavedBrief } from '@/lib/shared/api';
import { filterChips } from '@/lib/shared/chips';
import { Filters } from '@/lib/shared/filters';

export default function SavedRoute() {
  const saved = useSavedBriefs();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Saved searches</h1>
      <p className="mt-1 text-sm text-stone-600">Run one again to see who fits today.</p>
      <div className="mt-6">
        {saved.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading saved searches">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32 rounded-2xl" />
            ))}
          </div>
        ) : saved.isError ? (
          <ErrorBanner title="Couldn’t load your saved searches" onRetry={() => saved.refetch()} retrying={saved.isFetching}>
            {saved.error.message}
          </ErrorBanner>
        ) : saved.data.length === 0 ? (
          <EmptyState
            icon={Star}
            title="No saved searches yet"
            actions={
              <Button asChild>
                <Link href="/">
                  <Search /> Start a search
                </Link>
              </Button>
            }
          >
            After a search, press <span className="font-medium text-stone-800">Save search</span> next to the filters to keep the brief and its filters here.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {saved.data.map((s) => (
              <li key={s.id}>
                <SavedRow saved={s} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SavedRow({ saved }: { saved: SavedBrief }) {
  const router = useRouter();
  const plan = usePlan();
  const openUpgrade = useUpgrade();
  const toast = useToast();
  const refine = useRefine();
  const del = useDeleteSavedBrief();
  const [confirming, setConfirming] = useState(false);
  const parsed = Filters.safeParse(saved.filters);
  const chips = parsed.success ? filterChips(parsed.data) : [];
  const warnings = parsed.success ? (parsed.data.unsupported?.length ?? 0) : 0;

  const run = async () => {
    if (plan.data?.plan === 'free' && (plan.data.searches_remaining ?? 0) <= 0) {
      const fresh = (await plan.refetch()).data;
      if (fresh?.plan !== 'paid' && (fresh?.searches_remaining ?? 0) <= 0) return openUpgrade({ reason: 'limit', retry: () => void run() });
    }
    refine.mutate(
      { brief: saved.brief, filters: saved.filters, source: 'saved' },
      {
        onSuccess: (res) => router.push(searchHref(res.search_id)),
        onError: (err) => {
          if (isApiError(err, 402)) openUpgrade({ reason: 'limit', retry: () => void run() });
          else toast({ tone: 'error', title: isApiError(err, 400) ? 'This search uses filters the data no longer has. Run the brief as a new search instead.' : err.message });
        },
      },
    );
  };

  return (
    <article className="rounded-2xl bg-white p-4 ring-1 ring-stone-200 ring-inset sm:p-5">
      <div className="flex items-start gap-3">
        <Star aria-hidden className="mt-1 size-4 shrink-0 fill-amber-400 text-amber-400" />
        <div className="min-w-0 flex-1">
          <h2 className="font-medium text-pretty">{saved.brief}</h2>
          <p className="mt-0.5 text-[13px] text-stone-500">Saved {formatDate(saved.created_at)}</p>
          {chips.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Filters">
              {chips.map((c) => (
                <li key={c.key} className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-900 ring-1 ring-indigo-200 ring-inset">
                  {c.label}
                </li>
              ))}
            </ul>
          )}
          {warnings > 0 && (
            <p className="mt-2 flex items-center gap-1.5 text-[13px] text-amber-800">
              <TriangleAlert aria-hidden className="size-3.5" /> {warnings === 1 ? 'One part' : `${warnings} parts`} of this brief can’t be searched, so it finds no one.
            </p>
          )}
        </div>
      </div>

      {confirming ? (
        <div role="alertdialog" aria-label="Delete this saved search?" className="mt-4 flex flex-col gap-2 rounded-xl bg-red-50 p-3 ring-1 ring-red-200 ring-inset sm:flex-row sm:items-center">
          <p className="flex-1 text-sm text-red-900">Delete this saved search?</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" autoFocus onClick={() => setConfirming(false)} className="flex-1 sm:flex-none">
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={del.isPending}
              className="flex-1 sm:flex-none"
              onClick={() => del.mutate(saved.id, { onSuccess: () => toast({ title: 'Saved search deleted' }), onError: (err) => toast({ tone: 'error', title: err.message }) })}
            >
              {del.isPending ? <Spinner /> : <Trash2 />} Delete
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-stone-100 pt-3">
          <Button variant="secondary" size="sm" onClick={() => void run()} disabled={refine.isPending}>
            {refine.isPending ? <Spinner /> : <Play />} Run again
          </Button>
          <CostNote className="order-last basis-full text-[13px] sm:order-none sm:basis-auto" />
          <Button variant="ghost" size="icon" aria-label="Delete saved search" onClick={() => setConfirming(true)} className="ml-auto text-stone-500 hover:text-red-700">
            <Trash2 />
          </Button>
        </div>
      )}
    </article>
  );
}
