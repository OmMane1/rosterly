'use client';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Pencil, SearchX, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { CandidateCard } from '@/components/candidates/candidate-card';
import { ShortlistButton } from '@/components/shortlists/shortlist-picker';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useBroader, usePlan } from '@/lib/client/hooks/queries';
import { MAX_PAGE, type SearchPage } from '@/lib/shared/api';
import { filterChips, removeChip, requestedSkills, WITHOUT_UNSUPPORTED, withoutUnsupported } from '@/lib/shared/chips';
import { hasSubstantiveFilter, type Filters } from '@/lib/shared/filters';
import { CostNote } from './brief-form';

const searchQuery = (id: string, page: number) => `s=${encodeURIComponent(id)}${page > 1 ? `&page=${page}` : ''}`;
export const searchHref = (id: string, page = 1) => `/?${searchQuery(id, page)}`;

/** `?page=` as a page number; anything else is page 1. */
export const parsePage = (raw: string | null) => {
  const n = Number(raw ?? '1');
  return Number.isInteger(n) && n >= 1 && n <= MAX_PAGE ? n : 1;
};

type Props = {
  data: SearchPage;
  /** Edits are staged: these results are for the filters before them. */
  stale: boolean;
  busy: boolean;
  onOpenPerson: () => void;
  headingRef: (el: HTMLHeadingElement | null) => void;
  empty: ReactNode;
};

export function Results({ data, stale, busy, onOpenPerson, headingRef, empty }: Props) {
  const plan = usePlan();
  const pages = Math.max(1, Math.ceil(data.total / data.per_page));
  const highlight = requestedSkills(data.filters);
  const first = (data.page - 1) * data.per_page + 1;
  const last = first + data.results.length - 1;

  if (data.total === 0) return <div className="mt-6">{empty}</div>;

  return (
    <section aria-labelledby="results-heading" aria-busy={busy} className="mt-7">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="results-heading" ref={headingRef} tabIndex={-1} className="scroll-mt-24 text-lg font-semibold tracking-tight outline-none">
          {data.total.toLocaleString('en-US')} {data.total === 1 ? 'person' : 'people'}
        </h2>
        {pages > 1 && data.results.length > 0 && (
          <p className="text-sm text-stone-500 tabular-nums">
            {first === last ? first : `${first}–${last}`} of {data.total.toLocaleString('en-US')}
          </p>
        )}
      </div>
      {stale && <p className="mt-1 text-sm text-stone-500">Showing results for your filters before the changes.</p>}

      {data.results.length === 0 ? (
        <EmptyState icon={SearchX} title="This page is past the end" className="mt-4" actions={<Button asChild variant="secondary"><Link href={searchHref(data.search_id)}>Back to page 1</Link></Button>}>
          This search has {pages} {pages === 1 ? 'page' : 'pages'}.
        </EmptyState>
      ) : (
        <ol className={cn('mt-3 space-y-3 transition-opacity', (stale || busy) && 'opacity-55')}>
          {data.results.map((p) => (
            <li key={p.id}>
              <CandidateCard person={p} highlight={highlight} onOpen={onOpenPerson} from={searchQuery(data.search_id, data.page)} action={<ShortlistButton person={p} />} />
            </li>
          ))}
        </ol>
      )}

      {pages > 1 && (
        <nav aria-label="Pages" className="mt-6 flex items-center justify-between gap-3">
          <PageLink href={searchHref(data.search_id, data.page - 1)} disabled={data.page <= 1} dir="prev" />
          <p className="text-center text-[13px] text-stone-500">
            <span className="tabular-nums">
              Page {data.page} of {pages}
            </span>
            {plan.data?.plan === 'free' && <span className="block text-xs">Paging is always free</span>}
          </p>
          <PageLink href={searchHref(data.search_id, data.page + 1)} disabled={data.page >= pages} dir="next" />
        </nav>
      )}
    </section>
  );
}

function PageLink({ href, disabled, dir }: { href: string; disabled: boolean; dir: 'prev' | 'next' }) {
  const content =
    dir === 'prev' ? (
      <>
        <ArrowLeft /> <span>Previous</span>
      </>
    ) : (
      <>
        <span>Next</span> <ArrowRight />
      </>
    );
  if (disabled) {
    return (
      <Button variant="secondary" disabled aria-disabled className="min-w-28">
        {content}
      </Button>
    );
  }
  return (
    <Button asChild variant="secondary" className="min-w-28">
      <Link href={href} scroll={false} rel={dir}>
        {content}
      </Link>
    </Button>
  );
}

/** Why there's no one, and the next step (PLAN.md § 3.9: unsupported, vague, nothing matches). */
export function NoResults({ searchId, filters, onApply, onEditBrief, pending }: { searchId: string; filters: Filters; onApply: (f: Filters) => void; onEditBrief: () => void; pending: boolean }) {
  const unsupported = filters.unsupported ?? [];
  if (unsupported.length > 0) {
    const rest = withoutUnsupported(filters);
    const canSearchRest = hasSubstantiveFilter(rest);
    return (
      <EmptyState
        icon={TriangleAlert}
        tone="warning"
        title={unsupported.length === 1 ? 'Part of your brief can’t be searched' : 'Parts of your brief can’t be searched'}
        actions={
          canSearchRest ? (
            <div className="flex flex-col items-center gap-1.5">
              <Button onClick={() => onApply(rest)} disabled={pending}>
                Search without {unsupported.length === 1 ? 'it' : 'them'}
              </Button>
              <RestCount searchId={searchId} />
              <CostNote className="text-xs" />
            </div>
          ) : (
            <Button variant="secondary" onClick={onEditBrief}>
              <Pencil /> Edit the brief
            </Button>
          )
        }
      >
        <p>Rather than show people who don’t fit, Rosterly shows no one.</p>
        <ul className="mt-3 space-y-2 text-left">
          {unsupported.map((u, i) => (
            <li key={`${u.text}-${i}`} className="rounded-lg bg-white px-3 py-2 ring-1 ring-amber-200 ring-inset">
              <span className="font-medium text-amber-950">“{u.text}”</span>
              <span className="block text-stone-600">{u.reason}</span>
            </li>
          ))}
        </ul>
        {!canSearchRest && <p className="mt-3">Nothing else in the brief can be searched. Add a role, skill, location, level or years of experience.</p>}
      </EmptyState>
    );
  }
  if (!hasSubstantiveFilter(filters)) {
    return (
      <EmptyState icon={Pencil} title="Your brief needs something to search on" actions={<Button variant="secondary" onClick={onEditBrief}><Pencil /> Edit the brief</Button>}>
        Name a role, skill, location, level or years of experience, for example “backend engineers in Austin who know Go”. Rosterly never shows everyone.
      </EmptyState>
    );
  }
  return <NoOneMatches searchId={searchId} filters={filters} onApply={onApply} pending={pending} />;
}

const people = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}`;

/** What "search without it" would find, once the count is in. */
function RestCount({ searchId }: { searchId: string }) {
  const broader = useBroader(searchId);
  const total = broader.data?.options.find((o) => o.key === WITHOUT_UNSUPPORTED)?.total;
  if (total === undefined) return null;
  return <span className="text-xs text-stone-600">{total > 0 ? `Finds ${people(total)}` : 'That finds no one either'}</span>;
}

/** The three one-filter relaxations that find the most people, with how many each finds. */
const SHOWN = 3;

function NoOneMatches({ searchId, filters, onApply, pending }: { searchId: string; filters: Filters; onApply: (f: Filters) => void; pending: boolean }) {
  const broader = useBroader(searchId);
  const labels = new Map(filterChips(filters).map((c) => [c.key, c.label]));
  const options = (broader.data?.options ?? []).filter((o) => o.total > 0 && labels.has(o.key)).slice(0, SHOWN);
  // Counts that failed to load leave the plain advice; the suggestions are a shortcut, not the way.
  const noneWiden = broader.isSuccess && options.length === 0;

  return (
    <EmptyState
      icon={SearchX}
      title="No one matches all of these"
      actions={
        broader.isPending ? (
          <div className="flex w-full max-w-xs flex-col gap-2" aria-busy="true" aria-label="Looking for a broader search">
            <Skeleton className="h-10 rounded-xl" />
            <Skeleton className="h-10 rounded-xl" />
          </div>
        ) : options.length > 0 ? (
          <div className="flex w-full flex-col items-center gap-2">
            <p id="widen-heading" className="text-xs font-medium text-stone-500">
              Drop one filter
            </p>
            <ul aria-labelledby="widen-heading" className="flex w-full flex-col items-stretch gap-2 sm:w-auto">
              {options.map((o) => (
                <li key={o.key}>
                  <Button variant="secondary" className="w-full justify-between gap-3" disabled={pending} onClick={() => onApply(removeChip(filters, o.key))}>
                    <span className="truncate">Drop “{labels.get(o.key)}”</span>
                    <span className="shrink-0 font-normal text-stone-600 tabular-nums">{people(o.total)}</span>
                  </Button>
                </li>
              ))}
            </ul>
            <CostNote className="text-xs" />
          </div>
        ) : undefined
      }
    >
      {noneWiden
        ? 'Every filter has to match, and dropping any one of them still finds no one. Remove two, or loosen one in its editor.'
        : 'Every filter has to match. Remove or loosen one of the filters above to widen the search.'}
    </EmptyState>
  );
}
