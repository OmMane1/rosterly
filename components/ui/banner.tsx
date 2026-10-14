'use client';
import { CircleAlert, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { cn } from './cn';

/** A failed load or action, with a way out. */
export function ErrorBanner({ title, children, onRetry, retrying, className }: { title: string; children?: ReactNode; onRetry?: () => void; retrying?: boolean; className?: string }) {
  return (
    <div role="alert" className={cn('flex flex-col gap-3 rounded-xl bg-red-50 p-4 ring-1 ring-red-200 ring-inset sm:flex-row sm:items-center', className)}>
      <div className="flex min-w-0 flex-1 gap-3">
        <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-red-700" />
        <div className="min-w-0">
          <p className="font-medium text-red-900">{title}</p>
          {children && <div className="mt-0.5 text-sm text-red-800">{children}</div>}
        </div>
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} disabled={retrying} className="self-start sm:self-center">
          <RotateCw className={cn(retrying && 'animate-spin')} />
          Try again
        </Button>
      )}
    </div>
  );
}
