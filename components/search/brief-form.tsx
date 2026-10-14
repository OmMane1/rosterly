'use client';
// The brief box. Enter searches, Shift+Enter adds a line. On the free plan the caption under it says
// what pressing Search costs, or offers Upgrade once the free search is used (CLAUDE.md § UI rules).
import { ArrowRight, Search } from 'lucide-react';
import { useLayoutEffect, type FormEvent, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Spinner } from '@/components/ui/spinner';
import { useUpgrade } from '@/components/plan/upgrade';
import { usePlan } from '@/lib/client/hooks/queries';
import { MAX_BRIEF_LENGTH } from '@/lib/shared/brief';

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  pending: boolean;
  error?: string | null;
  large: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
};

export function BriefForm({ value, onChange, onSubmit, pending, error, large, inputRef }: Props) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!pending && value.trim()) onSubmit();
  };

  // Grow with the text, up to a third of the screen.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight / 3)}px`;
  }, [value, large, inputRef]);

  const near = value.length > MAX_BRIEF_LENGTH * 0.8;
  return (
    <form onSubmit={submit} role="search" aria-label="Candidate search">
      <div
        className={cn(
          'rounded-2xl bg-white shadow-sm ring-1 ring-stone-300 transition-shadow ring-inset focus-within:shadow-md focus-within:ring-2 focus-within:ring-indigo-600',
          error && 'ring-red-400',
        )}
      >
        <label htmlFor="brief" className="sr-only">
          Describe who you’re looking for
        </label>
        <textarea
          ref={inputRef}
          id="brief"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
          }}
          rows={large ? 3 : 1}
          maxLength={MAX_BRIEF_LENGTH}
          enterKeyHint="search"
          placeholder="e.g. Senior backend engineers in Austin who know Go"
          aria-invalid={error ? true : undefined}
          aria-describedby="brief-cost brief-error"
          className={cn('block w-full resize-none bg-transparent px-4 pt-3.5 text-base leading-6 outline-none placeholder:text-stone-400', large && 'sm:text-[17px] sm:leading-7')}
        />
        <div className="flex items-center gap-3 px-3 pt-1 pb-3 pl-4">
          <div id="brief-cost" className="min-w-0 flex-1 text-[13px]">
            {near ? (
              <span className="text-stone-500 tabular-nums">
                {value.length} / {MAX_BRIEF_LENGTH}
              </span>
            ) : (
              <CostNote />
            )}
          </div>
          <Button type="submit" disabled={pending || !value.trim()} className="rounded-xl">
            {pending ? <Spinner /> : <Search />}
            {pending ? 'Searching' : 'Search'}
          </Button>
        </div>
      </div>
      <p id="brief-error" role="alert" className={cn('mt-2 text-sm text-red-700', !error && 'sr-only')}>
        {error}
      </p>
    </form>
  );
}

/** What a new search costs on this plan; nothing on Paid. */
export function CostNote({ className, dark }: { className?: string; dark?: boolean }) {
  const plan = usePlan();
  const openUpgrade = useUpgrade();
  if (plan.data?.plan !== 'free') return null;
  if ((plan.data.searches_remaining ?? 0) > 0) return <span className={cn(dark ? 'text-stone-300' : 'text-stone-500', className)}>Uses your free search</span>;
  return (
    <button
      type="button"
      onClick={() => openUpgrade({ reason: 'limit' })}
      className={cn('inline-flex items-center gap-1 font-medium whitespace-nowrap underline-offset-2 hover:underline', dark ? 'text-amber-300' : 'text-amber-800', className)}
    >
      Free search used · Upgrade <ArrowRight aria-hidden className="size-3.5" />
    </button>
  );
}
