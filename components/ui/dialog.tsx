'use client';
// One dialog for every size: a bottom sheet on phones (thumb-reachable, swipe-sized) and a centred
// dialog from 640 px up.
import { X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from './cn';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

type ContentProps = {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Sticky actions at the bottom of the sheet. */
  footer?: ReactNode;
  onCloseAutoFocus?: (e: Event) => void;
};

export function DialogContent({ title, description, children, className, footer, onCloseAutoFocus }: ContentProps) {
  return (
    <D.Portal>
      <D.Overlay className="data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out fixed inset-0 z-50 bg-stone-950/40" />
      <D.Content
        // Radix's documented way to say "no description".
        {...(description ? {} : { 'aria-describedby': undefined })}
        onCloseAutoFocus={onCloseAutoFocus}
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-2xl bg-white shadow-2xl outline-none',
          'data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out',
          'sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-h-[85dvh] sm:w-[calc(100%-2rem)] sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl',
          'sm:data-[state=open]:animate-pop-in sm:data-[state=closed]:animate-pop-out',
          className,
        )}
      >
        <div aria-hidden className="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-stone-300 sm:hidden" />
        <div className="flex items-start justify-between gap-3 px-5 pt-3 sm:px-6 sm:pt-5">
          <div className="min-w-0 pt-1">
            <D.Title className="text-lg leading-6 font-semibold tracking-tight text-balance">{title}</D.Title>
            {description && <D.Description className="mt-1 text-sm text-stone-600">{description}</D.Description>}
          </div>
          <D.Close aria-label="Close" className="-mr-2 grid size-10 shrink-0 place-items-center rounded-full text-stone-500 hover:bg-stone-100 hover:text-ink">
            <X className="size-5" />
          </D.Close>
        </div>
        <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-4 sm:px-6 sm:pb-6', footer ? 'pb-4' : 'pb-[max(1.25rem,env(safe-area-inset-bottom))]')}>
          {children}
        </div>
        {footer && <div className="border-t border-stone-200 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">{footer}</div>}
      </D.Content>
    </D.Portal>
  );
}
