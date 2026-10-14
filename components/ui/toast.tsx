'use client';
// Small confirmations ("Search saved"). One polite live region, newest on top, gone after
// a few seconds; an action link is optional.
import Link from 'next/link';
import { Check, CircleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn';

type Toast = { id: number; title: string; tone: 'success' | 'error'; action?: { label: string; href: string } };
type Show = (t: Omit<Toast, 'id' | 'tone'> & { tone?: Toast['tone'] }) => void;

const ToastContext = createContext<Show>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback<Show>(
    (t) => {
      const id = ++next.current;
      setToasts((all) => [{ id, ...t, tone: t.tone ?? 'success' }, ...all].slice(0, 3));
      setTimeout(() => dismiss(id), 4500);
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.5rem)] z-[60] flex flex-col items-center gap-2 px-3 md:top-20 md:items-end md:px-6"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="animate-bar-in bg-ink pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl py-2.5 pr-2 pl-3.5 text-sm text-white shadow-xl"
          >
            {t.tone === 'success' ? <Check aria-hidden className="size-4 shrink-0 text-emerald-300" /> : <CircleAlert aria-hidden className="size-4 shrink-0 text-red-300" />}
            <span className="min-w-0 flex-1">{t.title}</span>
            {t.action && (
              <Link href={t.action.href} onClick={() => dismiss(t.id)} className="shrink-0 rounded-md px-2 py-1 font-medium text-indigo-200 underline-offset-2 hover:underline">
                {t.action.label}
              </Link>
            )}
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className={cn('grid size-8 shrink-0 place-items-center rounded-md text-stone-400 hover:text-white')}>
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
