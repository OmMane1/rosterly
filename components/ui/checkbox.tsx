'use client';
import { Check } from 'lucide-react';
import { Checkbox as C } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export function Checkbox({ className, ...props }: ComponentProps<typeof C.Root>) {
  return (
    <C.Root
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-md bg-white ring-1 ring-stone-400 ring-inset transition-colors',
        'data-[state=checked]:bg-indigo-600 data-[state=checked]:ring-indigo-600 disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <C.Indicator>
        <Check className="size-3.5 text-white" strokeWidth={3} />
      </C.Indicator>
    </C.Root>
  );
}
