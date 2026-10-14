'use client';
import { Plus } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useCreateShortlist } from '@/lib/client/hooks/mutations';
import { MAX_SHORTLIST_NAME, ShortlistName } from '@/lib/shared/api';

/** The inline "New list" form on the Shortlists page. */
export function NewListForm({ onDone }: { onDone: (id: string | null) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateShortlist();
  const id = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = ShortlistName.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Name the list.');
    create.mutate(parsed.data, { onSuccess: ({ id: listId }) => onDone(listId), onError: (err) => setError(err.message) });
  };

  return (
    <form onSubmit={submit} noValidate className="rounded-2xl bg-white p-4 ring-1 ring-stone-200 ring-inset sm:p-5">
      <label htmlFor={id} className="text-sm font-medium">
        Name the new list
      </label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <Input
          id={id}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Frontend, New York"
          maxLength={MAX_SHORTLIST_NAME}
          autoFocus
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onKeyDown={(e) => e.key === 'Escape' && onDone(null)}
        />
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => onDone(null)} className="flex-1 sm:flex-none">
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending} className="flex-1 sm:flex-none">
            {create.isPending ? <Spinner /> : <Plus />} Create list
          </Button>
        </div>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}
