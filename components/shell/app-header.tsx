'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PlanPill, UpgradeButton } from '@/components/plan/plan-pill';
import { cn } from '@/components/ui/cn';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/lib/client/hooks/queries';
import { AccountMenu } from './account-menu';
import { Logo } from './logo';
import { NAV } from './nav';

export function AppHeader() {
  const pathname = usePathname();
  const me = useMe();
  return (
    <header className="bg-canvas/85 sticky top-0 z-40 border-b border-stone-200/80 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4 sm:px-6 md:h-16">
        <Link href="/" className="flex shrink-0 items-center gap-2 rounded-lg" aria-label="Rosterly: new search">
          <Logo />
          <span className="hidden font-semibold tracking-tight sm:inline">Rosterly</span>
        </Link>
        <span aria-hidden className="hidden text-stone-300 sm:inline">
          /
        </span>
        {me.data ? (
          <span className="min-w-0 truncate text-sm font-semibold text-stone-800 sm:font-medium sm:text-stone-600">{me.data.company.name}</span>
        ) : (
          <Skeleton className="h-4 w-14" />
        )}

        <nav aria-label="Main" className="ml-6 hidden items-center gap-1 md:flex">
          {NAV.map(({ href, label, match }) => {
            const active = match(pathname);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn('rounded-lg px-3 py-2 text-sm font-medium transition-colors', active ? 'text-ink bg-stone-200/60' : 'text-stone-600 hover:bg-stone-100 hover:text-ink')}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <PlanPill />
          <UpgradeButton />
          <AccountMenu email={me.data?.email ?? null} company={me.data?.company.name ?? null} />
        </div>
      </div>
    </header>
  );
}
