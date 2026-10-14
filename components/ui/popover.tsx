'use client';
import { Popover as P } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export function PopoverContent({ className, ...props }: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        sideOffset={8}
        align="start"
        collisionPadding={16}
        className={cn(
          'data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out z-50 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl bg-white shadow-xl ring-1 ring-stone-200 outline-none',
          className,
        )}
        {...props}
      />
    </P.Portal>
  );
}
