'use client';
// The Upgrade dialog (PLAN.md § 3.9): what Free includes, what Paid adds, and how upgrading works.
// While it's open it polls the plan, so the moment Stripe's webhook confirms a subscription it turns
// into a "you're on Paid" state, and a search that hit the limit can run straight away.
import { Check, CircleCheck, CreditCard, ShieldCheck, Zap } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe, usePlan } from '@/lib/client/hooks/queries';

type OpenOptions = { reason?: 'limit' | 'plan'; /** What to run once the plan is Paid (the blocked search). */ retry?: () => void };
const UpgradeContext = createContext<(o?: OpenOptions) => void>(() => {});

/** Opens the Upgrade dialog. `reason: 'limit'` when a search was just refused. */
export const useUpgrade = () => useContext(UpgradeContext);

export function UpgradeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OpenOptions | null>(null);
  const open = useCallback((o: OpenOptions = {}) => setState({ reason: 'plan', ...o }), []);
  const value = useMemo(() => open, [open]);
  return (
    <UpgradeContext.Provider value={value}>
      {children}
      <Dialog open={state !== null} onOpenChange={(o) => !o && setState(null)}>
        {state && <UpgradeContent reason={state.reason ?? 'plan'} retry={state.retry} onClose={() => setState(null)} />}
      </Dialog>
    </UpgradeContext.Provider>
  );
}

const FREE = ['1 search in total', 'Paging is always free', 'Shortlists and saved searches'];
const PAID = ['Unlimited searches', 'Edits and re-runs apply at once', 'Everything in Free'];

function UpgradeContent({ reason, retry, onClose }: { reason: 'limit' | 'plan'; retry?: () => void; onClose: () => void }) {
  const plan = usePlan(true);
  const me = useMe();
  const paid = plan.data?.plan === 'paid';
  const left = plan.data?.searches_remaining ?? 0;
  const company = me.data?.company.name ?? 'Your company';

  const title = paid ? 'You’re on Paid' : reason === 'limit' ? 'You’ve used your free search' : left > 0 ? 'Your plan' : 'Upgrade to keep searching';
  // The status row and the plan cards already say what each plan includes; this only adds what a
  // refused search needs to hear.
  const description = !paid && reason === 'limit' ? 'Paging through the results you already have stays free. Upgrade to run new searches.' : undefined;

  const footer = paid ? (
    <Button
      className="w-full"
      onClick={() => {
        onClose();
        retry?.();
      }}
    >
      {retry ? 'Run the search now' : 'Continue'}
    </Button>
  ) : (
    <Button variant="secondary" className="w-full" onClick={onClose}>
      Got it
    </Button>
  );

  return (
    <DialogContent title={title} description={description} footer={footer} className="sm:max-w-xl">
      <div className="space-y-4">
        <Status loading={plan.isPending} paid={paid} left={left} company={company} />

        <div className="grid grid-cols-2 gap-2.5">
          <PlanCard name="Free" items={FREE} current={!paid && !plan.isPending} />
          <PlanCard name="Paid" items={PAID} current={paid} highlight />
        </div>

        {!paid && (
          <section aria-labelledby="how-upgrading-works">
            <h3 id="how-upgrading-works" className="text-sm font-semibold">
              How upgrading works
            </h3>
            <ol className="mt-2 space-y-1.5">
              <Step n={1} icon={CreditCard}>
                {company} subscribes through Stripe. Rosterly never sees the card.
              </Step>
              <Step n={2} icon={ShieldCheck}>
                Stripe confirms it to Rosterly with a signed webhook.
              </Step>
              <Step n={3} icon={Zap}>
                Paid switches on here by itself. No reload needed.
              </Step>
            </ol>
          </section>
        )}
      </div>
    </DialogContent>
  );
}

function Status({ loading, paid, left, company }: { loading: boolean; paid: boolean; left: number; company: string }) {
  if (loading) return <Skeleton className="h-[3.25rem] rounded-xl" />;
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl px-3.5 py-2 ring-1 ring-inset',
        paid ? 'bg-emerald-50 ring-emerald-200' : left > 0 ? 'bg-stone-50 ring-stone-200' : 'bg-amber-50 ring-amber-200',
      )}
    >
      {paid ? (
        <CircleCheck aria-hidden className="size-5 shrink-0 text-emerald-700" />
      ) : (
        <span aria-hidden className="relative flex size-2.5 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-indigo-400 opacity-60" />
          <span className="relative inline-flex size-2.5 rounded-full bg-indigo-500" />
        </span>
      )}
      <div className="min-w-0 text-sm" aria-live="polite">
        <p className="font-medium">
          {company} is on {paid ? 'Paid' : 'Free'}
          {!paid && <span className="font-normal text-stone-600"> · {left === 0 ? 'no searches left' : `${left} ${left === 1 ? 'search' : 'searches'} left`}</span>}
        </p>
        <p className="text-stone-600">{paid ? 'Every search, edit and re-run is included.' : 'Watching for Stripe’s confirmation…'}</p>
      </div>
    </div>
  );
}

function PlanCard({ name, items, current, highlight }: { name: string; items: string[]; current: boolean; highlight?: boolean }) {
  return (
    <div className={cn('rounded-xl px-3 py-2.5 ring-1 ring-inset', highlight ? 'bg-indigo-50/60 ring-indigo-200' : 'bg-white ring-stone-200')}>
      <div className="flex h-5 items-center justify-between gap-2">
        <p className="text-sm font-semibold">{name}</p>
        {current && <span className="bg-ink rounded-full px-2 py-px text-[11px] font-medium text-white">Current</span>}
      </div>
      <ul className="mt-1.5 space-y-1">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5 text-[13px] leading-[1.125rem] text-stone-700">
            <Check aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', highlight ? 'text-indigo-600' : 'text-stone-400')} strokeWidth={2.5} />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Step({ n, icon: Icon, children }: { n: number; icon: typeof Zap; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm text-stone-700">
      <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-stone-100 text-stone-600">
        <Icon className="size-3.5" />
      </span>
      <p className="min-w-0 pt-0.5">
        <span className="sr-only">Step {n}: </span>
        {children}
      </p>
    </li>
  );
}
