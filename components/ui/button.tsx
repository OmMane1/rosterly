import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

const VARIANTS = {
  primary: 'bg-ink text-white shadow-sm hover:bg-stone-800 active:bg-stone-900',
  secondary: 'bg-white text-ink ring-1 ring-inset ring-stone-300 hover:bg-stone-50 active:bg-stone-100',
  ghost: 'text-stone-700 hover:bg-stone-100 hover:text-ink active:bg-stone-200',
  danger: 'bg-red-700 text-white shadow-sm hover:bg-red-800',
  accent: 'bg-indigo-50 text-indigo-800 ring-1 ring-inset ring-indigo-200 hover:bg-indigo-100',
} as const;

// Phones get 44 px targets; desktops a little tighter.
const SIZES = {
  sm: 'h-9 gap-1.5 px-3 text-sm sm:h-8',
  md: 'h-11 gap-2 px-4 text-sm sm:h-10',
  lg: 'h-12 gap-2 px-5 text-base',
  icon: 'size-11 sm:size-10',
} as const;

export type ButtonProps = ComponentProps<'button'> & { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES; asChild?: boolean };

export function Button({ variant = 'primary', size = 'md', asChild, className, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
