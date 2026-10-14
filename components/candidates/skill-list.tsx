import { Check } from 'lucide-react';
import { cn } from '@/components/ui/cn';

/** Skills, with the ones the search asked for first and highlighted; `max` shows that many and a count. */
export function SkillList({ skills, highlight, max, className }: { skills: string[]; highlight?: Set<string>; max?: number; className?: string }) {
  const matched = skills.filter((s) => highlight?.has(s));
  const rest = skills.filter((s) => !highlight?.has(s)).slice(0, max === undefined ? undefined : Math.max(0, max - matched.length));
  const hidden = skills.length - matched.length - rest.length;
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)} aria-label="Skills">
      {matched.map((s) => (
        <li key={s} className="inline-flex h-6 items-center gap-1 rounded-md bg-indigo-50 px-2 text-xs font-medium text-indigo-800 ring-1 ring-indigo-200 ring-inset">
          <Check aria-hidden className="size-3" strokeWidth={3} />
          {s}
          <span className="sr-only"> (matches your search)</span>
        </li>
      ))}
      {rest.map((s) => (
        <li key={s} className="inline-flex h-6 items-center rounded-md bg-stone-100 px-2 text-xs text-stone-700">
          {s}
        </li>
      ))}
      {hidden > 0 && (
        <li className="inline-flex h-6 items-center rounded-md px-1 text-xs text-stone-500">
          +{hidden}
          <span className="sr-only"> more skills</span>
        </li>
      )}
    </ul>
  );
}

export function OpenToWork({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-700', className)}>
      <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
      Open to work
    </span>
  );
}
