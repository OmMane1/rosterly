import { cn } from './cn';

export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cn('animate-shimmer rounded-md bg-stone-200/80', className)} />;
