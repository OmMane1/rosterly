import { Skeleton } from '@/components/ui/skeleton';
import { Logo } from './logo';

/** What a signed-in page looks like while the session is checked. */
export function ShellSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="border-b border-stone-200/80">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4 sm:px-6 md:h-16">
          <Logo />
          <Skeleton className="ml-auto h-8 w-28 rounded-full" />
        </div>
      </div>
      <div className="mx-auto max-w-3xl space-y-4 px-4 pt-8 sm:px-6">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-32 rounded-2xl" />
      </div>
    </div>
  );
}
