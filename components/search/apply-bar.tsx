'use client';
// Unapplied chip edits (free plan). It floats above everything, in ink, until the edits are applied
// or discarded, and says what applying costs, so a change can't silently go unapplied or spend the
// free search by surprise.
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { CostNote } from './brief-form';

export function ApplyBar({ count, canApply, pending, onApply, onDiscard }: { count: number; canApply: boolean; pending: boolean; onApply: () => void; onDiscard: () => void }) {
  return (
    <div
      role="region"
      aria-label="Unapplied filter changes"
      className="animate-bar-in fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 px-3 md:bottom-6"
    >
      <div className="bg-ink mx-auto flex max-w-xl items-center gap-2 rounded-2xl py-2 pr-2 pl-4 text-white shadow-2xl shadow-stone-900/30 ring-1 ring-white/10">
        <div className="min-w-0 flex-1" aria-live="polite">
          <p className="text-sm font-medium">
            {count} {count === 1 ? 'change' : 'changes'} not applied
          </p>
          <p className="truncate text-xs">{canApply ? <CostNote dark /> : <span className="text-amber-300">Add at least one filter to search</span>}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onDiscard} className="text-stone-300 hover:bg-white/10 hover:text-white">
          Discard
        </Button>
        <Button size="md" onClick={onApply} disabled={!canApply || pending} className="text-ink bg-white hover:bg-stone-100 active:bg-stone-200">
          {pending && <Spinner />}
          Apply
        </Button>
      </div>
    </div>
  );
}
