'use client';
import { DropdownMenu as M } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuLabel = M.Label;

export function MenuContent({ className, ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={8}
        collisionPadding={16}
        className={cn(
          'data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out z-50 min-w-56 rounded-xl bg-white p-1.5 shadow-xl ring-1 ring-stone-200',
          className,
        )}
        {...props}
      />
    </M.Portal>
  );
}

export function MenuItem({ className, ...props }: ComponentProps<typeof M.Item>) {
  return (
    <M.Item
      className={cn(
        'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm text-stone-800 outline-none select-none sm:min-h-9',
        'data-[highlighted]:bg-stone-100 data-[highlighted]:text-ink [&_svg]:size-4 [&_svg]:text-stone-500',
        className,
      )}
      {...props}
    />
  );
}

export const MenuSeparator = () => <M.Separator className="my-1.5 h-px bg-stone-200" />;
