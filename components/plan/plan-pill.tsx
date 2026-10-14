'use client';
// Always-visible plan status (CLAUDE.md § UI rules). Tapping it opens the Upgrade dialog, so on a
// phone, where there is no room for a separate Upgrade button, the pill is the way in.
import { Check, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Skeleton } from '@/components/ui/skeleton';
import { usePlan } from '@/lib/client/hooks/queries';
import { useUpgrade } from './upgrade';

export function PlanPill() {
  const plan = usePlan();
  const openUpgrade = useUpgrade();

  if (plan.isPending) return <Skeleton className="h-8 w-28 rounded-full" />;
  if (plan.isError) {
    return (
      <button type="button" onClick={() => plan.refetch()} className="flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-stone-600 ring-1 ring-stone-300 ring-inset">
        <RotateCw aria-hidden className="size-3.5" /> Plan unavailable
      </button>
    );
  }

  const { plan: name, searches_remaining: left } = plan.data;
  const paid = name === 'paid';
  const out = !paid && (left ?? 0) <= 0;
  const leftText = `${left ?? 0} ${left === 1 ? 'search' : 'searches'} left`;
  return (
    <button
      type="button"
      onClick={() => openUpgrade()}
      aria-label={paid ? 'Plan: Paid. Show plan details' : `Plan: Free, ${leftText}. Show plan and how to upgrade`}
      className={cn(
        'flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium whitespace-nowrap ring-1 transition-colors ring-inset',
        paid && 'bg-emerald-50 text-emerald-800 ring-emerald-200 hover:bg-emerald-100',
        out && 'bg-amber-50 text-amber-900 ring-amber-300 hover:bg-amber-100',
        !paid && !out && 'bg-white text-stone-700 ring-stone-300 hover:bg-stone-50',
      )}
    >
      {paid ? <Check aria-hidden className="size-3.5" strokeWidth={2.5} /> : <span aria-hidden className={cn('size-1.5 rounded-full', out ? 'bg-amber-500' : 'bg-indigo-500')} />}
      {paid ? (
        'Paid'
      ) : (
        <span>
          Free · <span className="tabular-nums">{left ?? 0}</span>
          <span className="hidden sm:inline">{left === 1 ? ' search' : ' searches'}</span> left
          {out && (
            <span className="md:hidden">
              {' · '}
              <span className="font-semibold underline underline-offset-2">Upgrade</span>
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/** Desktop only: phones reach Upgrade through the pill. */
export function UpgradeButton() {
  const plan = usePlan();
  const openUpgrade = useUpgrade();
  if (plan.data?.plan !== 'free') return null;
  return (
    <Button size="sm" onClick={() => openUpgrade()} className="hidden md:inline-flex">
      Upgrade
    </Button>
  );
}
