'use client';
import { CornerDownLeft } from 'lucide-react';

// Written for the UI (never taken from data/queries.json). Each one shows a different kind of
// filter, so a recruiter sees what the box understands: levels, skills, places, years, history,
// education.
export const EXAMPLE_BRIEFS = [
  'Staff backend engineers in Seattle who know Go and Kafka',
  'Data engineers in Denver or Austin with 5+ years of experience',
  'Product managers who used to work at a startup and have an MBA',
  'Designers open to work who studied at Carnegie Mellon',
] as const;

/** Tapping one fills the box; it doesn't search, so the free search is never spent by accident. */
export function ExampleBriefs({ onPick }: { onPick: (brief: string) => void }) {
  return (
    <section aria-labelledby="examples" className="mt-8">
      <h2 id="examples" className="text-xs font-semibold tracking-wider text-stone-500 uppercase">
        Try a brief
      </h2>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {EXAMPLE_BRIEFS.map((b) => (
          <li key={b}>
            <button
              type="button"
              onClick={() => onPick(b)}
              className="group flex h-full w-full items-start gap-3 rounded-xl bg-white p-3.5 text-left text-sm text-stone-700 ring-1 ring-stone-200 transition ring-inset hover:text-ink hover:ring-stone-300 hover:shadow-sm"
            >
              <span className="flex-1">{b}</span>
              <CornerDownLeft aria-hidden className="mt-0.5 size-4 shrink-0 text-stone-300 group-hover:text-stone-500" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
