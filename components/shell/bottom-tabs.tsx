'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { NAV } from './nav';

/** Phones: the three places, under the thumb. */
export function BottomTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-stone-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden">
      <ul className="mx-auto grid h-16 max-w-md grid-cols-3">
        {NAV.map(({ href, label, icon: Icon, match }) => {
          const active = match(pathname);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn('flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors', active ? 'text-ink' : 'text-stone-500 hover:text-stone-800')}
              >
                <span className={cn('grid h-7 w-12 place-items-center rounded-full transition-colors', active && 'bg-stone-200/70')}>
                  <Icon aria-hidden className="size-[18px]" strokeWidth={active ? 2.4 : 2} />
                </span>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
