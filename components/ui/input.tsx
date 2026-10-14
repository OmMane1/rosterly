import type { ComponentProps } from 'react';
import { cn } from './cn';

// 16 px text on phones, so iOS never zooms into a focused field.
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-11 w-full min-w-0 rounded-lg bg-white px-3 text-base text-ink ring-1 ring-stone-300 transition-shadow ring-inset outline-none placeholder:text-stone-400 focus:ring-2 focus:ring-indigo-600 sm:h-10 sm:text-sm',
        'aria-[invalid=true]:ring-red-600',
        className,
      )}
      {...props}
    />
  );
}
