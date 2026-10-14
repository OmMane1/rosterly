'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bookmark, ChevronRight, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '@/components/candidates/avatar';
import { NewListForm } from '@/components/shortlists/new-list-form';
import { ErrorBanner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/client/format';
import { useShortlists } from '@/lib/client/hooks/queries';
import type { Shortlist } from '@/lib/shared/api';

export default function ShortlistsRoute() {
  const lists = useShortlists();
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Shortlists</h1>
          <p className="mt-1 text-sm text-stone-600">People you’re keeping, in lists your whole company shares.</p>
        </div>
        {!creating && lists.data && lists.data.length > 0 && (
          <Button onClick={() => setCreating(true)} className="shrink-0">
            <Plus /> New list
          </Button>
        )}
      </div>

      {creating && (
        <div className="mt-5">
          <NewListForm
            onDone={(id) => {
              setCreating(false);
              if (id) router.push(`/shortlists/${id}`);
            }}
          />
        </div>
      )}

      <div className="mt-6">
        {lists.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label="Loading lists">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
        ) : lists.isError ? (
          <ErrorBanner title="Couldn’t load your shortlists" onRetry={() => lists.refetch()} retrying={lists.isFetching}>
            {lists.error.message}
          </ErrorBanner>
        ) : lists.data.length === 0 ? (
          !creating && (
            <EmptyState
              icon={Bookmark}
              title="No shortlists yet"
              actions={
                <>
                  <Button asChild variant="secondary">
                    <Link href="/">
                      <Search /> Find people
                    </Link>
                  </Button>
                  <Button onClick={() => setCreating(true)}>
                    <Plus /> New list
                  </Button>
                </>
              }
            >
              Press <span className="font-medium text-stone-800">Shortlist</span> on anyone in your search results to keep them here, or start with an empty list.
            </EmptyState>
          )
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {lists.data.map((l) => (
              <li key={l.id}>
                <ListCard list={l} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ListCard({ list }: { list: Shortlist }) {
  const faces = list.people.slice(0, 5);
  return (
    <Link
      href={`/shortlists/${list.id}`}
      className="group flex h-full flex-col rounded-2xl bg-white p-4 ring-1 ring-stone-200 transition ring-inset hover:shadow-md hover:shadow-stone-200/60 hover:ring-stone-300 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{list.name}</h2>
          <p className="mt-0.5 text-[13px] text-stone-500">
            {list.people_count === 1 ? '1 person' : `${list.people_count} people`} · updated {formatDate(list.updated_at)}
          </p>
        </div>
        <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-stone-300 transition group-hover:translate-x-0.5 group-hover:text-stone-500" />
      </div>
      <div className="mt-4 flex items-center">
        {faces.length === 0 ? (
          <span className="text-[13px] text-stone-400">No one yet</span>
        ) : (
          <>
            <span className="flex -space-x-2">
              {faces.map((p) => (
                <Avatar key={p.id} src={p.avatar_url} name={p.full_name} size={30} className="ring-2 ring-white" />
              ))}
            </span>
            {list.people_count > faces.length && <span className="ml-2 text-[13px] text-stone-500 tabular-nums">+{list.people_count - faces.length}</span>}
          </>
        )}
      </div>
    </Link>
  );
}
