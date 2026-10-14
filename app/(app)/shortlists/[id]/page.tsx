'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Bookmark, Check, Pencil, Search, Trash2, X } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { CandidateCard, CandidateListSkeleton } from '@/components/candidates/candidate-card';
import { BackButton } from '@/components/candidates/back-button';
import { ErrorBanner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { isApiError } from '@/lib/client/api';
import { formatDate } from '@/lib/client/format';
import { useDeleteShortlist, useRenameShortlist, useShortlistMembership } from '@/lib/client/hooks/mutations';
import { useShortlist } from '@/lib/client/hooks/queries';
import { MAX_SHORTLIST_NAME, ShortlistName, type Shortlist } from '@/lib/shared/api';

export default function ShortlistRoute() {
  const { id } = useParams<{ id: string }>();
  const list = useShortlist(id);
  return (
    <div className="mx-auto max-w-3xl">
      <BackButton href="/shortlists" label="Shortlists" />
      {list.isPending ? (
        <div className="mt-2" aria-busy="true" aria-label="Loading list">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-2 h-4 w-32" />
          <div className="mt-6">
            <CandidateListSkeleton count={3} />
          </div>
        </div>
      ) : list.isError ? (
        isApiError(list.error, 404) ? (
          <EmptyState
            icon={Bookmark}
            title="This list doesn’t exist"
            className="mt-4"
            actions={
              <Button asChild variant="secondary">
                <Link href="/shortlists">All shortlists</Link>
              </Button>
            }
          >
            It may have been deleted, or it belongs to another company.
          </EmptyState>
        ) : (
          <ErrorBanner className="mt-4" title="Couldn’t load this list" onRetry={() => list.refetch()} retrying={list.isFetching}>
            {list.error.message}
          </ErrorBanner>
        )
      ) : (
        <ListView list={list.data} />
      )}
    </div>
  );
}

function ListView({ list }: { list: Shortlist }) {
  const membership = useShortlistMembership();
  const toast = useToast();
  return (
    <>
      <ListHeader list={list} />
      {list.people.length === 0 ? (
        <EmptyState
          icon={Bookmark}
          title="No one on this list yet"
          className="mt-6"
          actions={
            <Button asChild>
              <Link href="/">
                <Search /> Find people
              </Link>
            </Button>
          }
        >
          Press <span className="font-medium text-stone-800">Shortlist</span> on a search result or a profile and tick “{list.name}”.
        </EmptyState>
      ) : (
        <ol className="mt-6 space-y-3">
          {list.people.map((p) => (
            <li key={p.id}>
              <CandidateCard
                person={p}
                from={`list=${encodeURIComponent(list.id)}`}
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-stone-600"
                    aria-label={`Remove ${p.full_name} from ${list.name}`}
                    onClick={() =>
                      membership.mutate(
                        { listId: list.id, person: p, add: false },
                        { onSuccess: () => toast({ title: `Removed ${p.full_name.split(' ')[0]} from ${list.name}` }), onError: (err) => toast({ tone: 'error', title: err.message }) },
                      )
                    }
                  >
                    <X /> Remove
                  </Button>
                }
              />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function ListHeader({ list }: { list: Shortlist }) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const del = useDeleteShortlist();
  const router = useRouter();
  const toast = useToast();

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <RenameForm list={list} onDone={() => setRenaming(false)} />
          ) : (
            <button type="button" onClick={() => setRenaming(true)} className="group -ml-1.5 flex max-w-full items-center gap-2 rounded-lg px-1.5 py-0.5 text-left hover:bg-stone-100" aria-label={`Rename ${list.name}`}>
              <h1 className="truncate text-2xl font-semibold tracking-tight">{list.name}</h1>
              <Pencil aria-hidden className="size-4 shrink-0 text-stone-400 group-hover:text-stone-600" />
            </button>
          )}
          <p className="mt-1 text-sm text-stone-500">
            {list.people_count === 1 ? '1 person' : `${list.people_count} people`} · created {formatDate(list.created_at)}
          </p>
        </div>
        {!confirming && !renaming && (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} className="text-red-700 hover:bg-red-50 hover:text-red-800">
            <Trash2 /> Delete list
          </Button>
        )}
      </div>

      {confirming && (
        <div role="alertdialog" aria-labelledby="confirm-delete" className="mt-4 flex flex-col gap-3 rounded-xl bg-red-50 p-4 ring-1 ring-red-200 ring-inset sm:flex-row sm:items-center">
          <p id="confirm-delete" className="flex-1 text-sm text-red-900">
            Delete “{list.name}”? The list goes for everyone at your company; the people stay searchable.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} autoFocus className="flex-1 sm:flex-none">
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={del.isPending}
              className="flex-1 sm:flex-none"
              onClick={() =>
                del.mutate(list.id, {
                  onSuccess: () => {
                    toast({ title: `Deleted ${list.name}` });
                    router.replace('/shortlists');
                  },
                  onError: (err) => toast({ tone: 'error', title: err.message }),
                })
              }
            >
              {del.isPending ? <Spinner /> : <Trash2 />} Delete list
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RenameForm({ list, onDone }: { list: Shortlist; onDone: () => void }) {
  const [name, setName] = useState(list.name);
  const [error, setError] = useState<string | null>(null);
  const rename = useRenameShortlist();
  const id = useId();

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const parsed = ShortlistName.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Name the list.');
    if (parsed.data === list.name) return onDone();
    rename.mutate({ id: list.id, name: parsed.data }, { onSuccess: onDone, onError: (err) => setError(err.message) });
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <label htmlFor={id} className="sr-only">
        List name
      </label>
      <Input
        id={id}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={MAX_SHORTLIST_NAME}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => e.key === 'Escape' && onDone()}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="text-lg font-semibold sm:h-11 sm:text-lg"
      />
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onDone} className="flex-1 sm:flex-none">
          Cancel
        </Button>
        <Button type="submit" disabled={rename.isPending} className="flex-1 sm:flex-none">
          {rename.isPending ? <Spinner /> : <Check />} Save
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-red-700 sm:basis-full">
          {error}
        </p>
      )}
    </form>
  );
}
