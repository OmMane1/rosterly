import { cn } from '@/components/ui/cn';

export function Logo({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('bg-ink grid size-7 place-items-center rounded-lg text-white', className)}>
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
        <circle cx="7" cy="7" r="4.2" />
        <path d="m10.2 10.2 3.3 3.3" />
      </svg>
    </span>
  );
}
