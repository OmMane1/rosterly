'use client';
// "Shortlist" on a person: a labelled bookmark button that opens a picker with a checkbox per list
// (each tick saves at once) and a field to start a new list. The button reads "Shortlisted" once the
// person is on any list, so it's obvious from the results who has been kept.
import { Bookmark, BookmarkCheck, Plus } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/components/ui/cn';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { ErrorBanner } from '@/components/ui/banner';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { useCreateShortlist, useShortlistMembership } from '@/lib/client/hooks/mutations';
import { useShortlists } from '@/lib/client/hooks/queries';
import { MAX_SHORTLIST_NAME, ShortlistName, type Card } from '@/lib/shared/api';

export function ShortlistButton({ person, size = 'sm', className }: { person: Card; size?: 'sm' | 'md'; className?: string }) {
  const lists = useShortlists();
  const on = lists.data?.filter((l) => l.people.some((p) => p.id === person.id)) ?? [];
  const kept = on.length > 0;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant={kept ? 'accent' : 'secondary'}
          size={size}
          aria-label={kept ? `${person.full_name} is shortlisted. Change lists` : `Shortlist ${person.full_name}`}
          className={className}
        >
          {kept ? <BookmarkCheck className="fill-indigo-600/15" /> : <Bookmark />}
          {kept ? 'Shortlisted' : 'Shortlist'}
        </Button>
      </DialogTrigger>
      <ShortlistPicker person={person} />
    </Dialog>
  );
}

function ShortlistPicker({ person }: { person: Card }) {
  const lists = useShortlists();
  const membership = useShortlistMembership();
  const toast = useToast();
  const first = person.full_name.split(' ')[0] ?? person.full_name;

  // The tick is the confirmation (it's optimistic and rolls back on failure), so only errors toast.
  const toggle = (listId: string, add: boolean) => membership.mutate({ listId, person, add }, { onError: (err) => toast({ tone: 'error', title: err.message }) });

  return (
    <DialogContent title={`Shortlist ${person.full_name}`} description={lists.data?.length ? 'Tick the lists to keep them on. Changes save right away.' : undefined}>
      {lists.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading lists">
          <Skeleton className="h-12 rounded-xl" />
          <Skeleton className="h-12 rounded-xl" />
        </div>
      ) : lists.isError ? (
        <ErrorBanner title="Couldn’t load your lists" onRetry={() => lists.refetch()} retrying={lists.isFetching}>
          {lists.error.message}
        </ErrorBanner>
      ) : (
        <div className="space-y-4">
          {lists.data.length > 0 ? (
            <ul className="divide-y divide-stone-100 overflow-hidden rounded-xl ring-1 ring-stone-200 ring-inset">
              {lists.data.map((l) => {
                const checked = l.people.some((p) => p.id === person.id);
                return (
                  <li key={l.id}>
                    <label className="flex min-h-13 cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-stone-50">
                      <Checkbox checked={checked} onCheckedChange={(v) => toggle(l.id, v === true)} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{l.name}</span>
                      <span className="shrink-0 text-xs text-stone-500 tabular-nums">{l.people_count === 1 ? '1 person' : `${l.people_count} people`}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="rounded-xl bg-stone-50 px-4 py-3 text-sm text-stone-600">You have no lists yet. Name your first one and {first} goes straight in.</p>
          )}
          <NewListForm person={person} autoFocus={lists.data.length === 0} />
        </div>
      )}
    </DialogContent>
  );
}

function NewListForm({ person, autoFocus }: { person: Card; autoFocus: boolean }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateShortlist();
  const membership = useShortlistMembership();
  const toast = useToast();
  const id = useId();
  const busy = create.isPending || membership.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = ShortlistName.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Name the list.');
    setError(null);
    create.mutate(parsed.data, {
      onSuccess: ({ id: listId }) =>
        membership.mutate(
          { listId, person, add: true },
          {
            onSuccess: () => {
              setName('');
              toast({ title: `Created ${parsed.data} with ${person.full_name.split(' ')[0]}`, action: { label: 'Open', href: `/shortlists/${listId}` } });
            },
            onError: (err) => setError(err.message),
          },
        ),
      onError: (err) => setError(err.message),
    });
  };

  return (
    <form onSubmit={submit} noValidate>
      <label htmlFor={id} className="text-sm font-medium">
        New list
      </label>
      <div className="mt-1.5 flex gap-2">
        <Input
          id={id}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Frontend, New York"
          maxLength={MAX_SHORTLIST_NAME}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          autoComplete="off"
        />
        <Button type="submit" variant="primary" disabled={busy} className="shrink-0">
          {busy ? <Spinner /> : <Plus />}
          Create
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className={cn('mt-1.5 text-sm text-red-700')}>
          {error}
        </p>
      )}
    </form>
  );
}
