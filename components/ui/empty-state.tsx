import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';

/** An empty list or result that says why it's empty and what to do next. */
export function EmptyState({ icon: Icon, title, children, actions, tone = 'neutral', className }: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  tone?: 'neutral' | 'warning';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center rounded-2xl border border-dashed px-6 py-10 text-center', tone === 'warning' ? 'border-amber-300 bg-amber-50/60' : 'border-stone-300 bg-white', className)}>
      <span className={cn('grid size-11 place-items-center rounded-full', tone === 'warning' ? 'bg-amber-100 text-amber-800' : 'bg-stone-100 text-stone-600')}>
        <Icon aria-hidden className="size-5" />
      </span>
      <h2 className="mt-4 text-base font-semibold text-balance">{title}</h2>
      {children && <div className="mt-1.5 max-w-md text-sm text-pretty text-stone-600">{children}</div>}
      {actions && <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}
