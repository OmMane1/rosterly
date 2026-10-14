'use client';
import Link from 'next/link';
import { Bookmark, GraduationCap, MapPin } from 'lucide-react';
import type { ReactNode } from 'react';
import { ShortlistButton } from '@/components/shortlists/shortlist-picker';
import { Skeleton } from '@/components/ui/skeleton';
import { useShortlists } from '@/lib/client/hooks/queries';
import type { Person } from '@/lib/shared/api';
import { SENIORITY_LABELS } from '@/lib/shared/chips';
import type { Seniority } from '@/lib/shared/vocabulary.generated';
import { Avatar, CompanyLogo } from './avatar';
import { OpenToWork, SkillList } from './skill-list';

const span = (start: number, end: number | null) => {
  const years = (end ?? new Date().getFullYear()) - start;
  return years <= 0 ? 'under a year' : years === 1 ? '1 yr' : `${years} yrs`;
};

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={className}>
      <h2 className="text-xs font-semibold tracking-wider text-stone-500 uppercase">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** `highlight`: the skills the search that opened this profile asked for, marked as on the cards. */
export function CandidateProfile({ person, highlight }: { person: Person; highlight?: Set<string> }) {
  const lists = useShortlists();
  const on = lists.data?.filter((l) => l.people.some((p) => p.id === person.id)) ?? [];
  const current = person.experiences[0];
  return (
    <article className="mt-2">
      <header className="rounded-2xl bg-white p-5 ring-1 ring-stone-200 ring-inset sm:p-7">
        {/* Phones put the avatar beside the name, so skills start above the fold. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
          <div className="flex min-w-0 flex-1 items-start gap-4 sm:gap-5">
            <Avatar src={person.avatar_url} name={person.full_name} size={64} className="sm:size-24" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="text-2xl font-semibold tracking-tight">{person.full_name}</h1>
                {person.open_to_work && <OpenToWork className="rounded-full bg-emerald-50 px-2.5 py-1 ring-1 ring-emerald-200 ring-inset" />}
              </div>
              <p className="mt-1 text-[15px] text-stone-800">
                {person.current_title} <span className="text-stone-500">at</span>{' '}
                <span className="inline-flex items-center gap-1.5 align-middle">
                  <CompanyLogo src={person.current_company_logo_url} name={person.current_company} size={18} />
                  <span className="font-medium">{person.current_company}</span>
                </span>
              </p>
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-600">
                <span className="inline-flex items-center gap-1">
                  <MapPin aria-hidden className="size-3.5" /> {person.location.city}, {person.location.state}
                </span>
                <span>
                  {SENIORITY_LABELS[person.seniority as Seniority] ?? person.seniority} · {person.years_experience} {person.years_experience === 1 ? 'year' : 'years'} of experience
                </span>
              </p>
            </div>
          </div>
          <ShortlistButton person={person} size="md" className="w-full sm:w-auto" />
        </div>
        {on.length > 0 && (
          <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-stone-100 pt-4 text-sm text-stone-600">
            <Bookmark aria-hidden className="size-3.5 text-indigo-600" /> On
            {on.map((l, i) => (
              <span key={l.id}>
                <Link href={`/shortlists/${l.id}`} className="font-medium text-indigo-700 underline-offset-2 hover:underline">
                  {l.name}
                </Link>
                {i < on.length - 1 && ','}
              </span>
            ))}
          </p>
        )}
      </header>

      <div className="mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_18rem] md:grid-rows-[auto_1fr] md:gap-8">
        <Section title="Skills" className="md:col-start-2 md:row-start-1">
          <SkillList skills={person.skills} highlight={highlight} />
        </Section>

        <Section title="Experience" className="md:col-start-1 md:row-span-2 md:row-start-1">
          <ol className="relative">
            {person.experiences.map((e, i) => (
              <li key={`${e.company}-${e.start_year}-${i}`} className="relative flex gap-4 pb-6 last:pb-0">
                {i < person.experiences.length - 1 && <span aria-hidden className="absolute top-11 bottom-1 left-5 w-px bg-stone-200" />}
                <CompanyLogo src={e.company_logo_url} name={e.company} size={40} className="ring-1 ring-stone-200" />
                <div className="min-w-0 flex-1 pt-0.5">
                  <p className="font-medium">{e.title}</p>
                  <p className="text-sm text-stone-700">
                    {e.company}
                    <span className="ml-2 rounded-md bg-stone-100 px-1.5 py-0.5 text-[11px] font-medium text-stone-600">{e.company_type === 'startup' ? 'Startup' : 'Enterprise'}</span>
                  </p>
                  <p className="mt-0.5 text-[13px] text-stone-500 tabular-nums">
                    {e.start_year} – {e.end_year ?? 'now'} · {span(e.start_year, e.end_year)}
                    {e === current && <span className="sr-only"> (current job)</span>}
                  </p>
                  <p className="mt-1.5 text-sm text-pretty text-stone-600">{e.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <Section title="Education" className="md:col-start-2 md:row-start-2 md:self-start">
          <ul className="space-y-3">
            {person.education.map((ed, i) => (
              <li key={`${ed.school}-${i}`} className="flex gap-3">
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-600">
                  <GraduationCap className="size-4" />
                </span>
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{ed.school}</p>
                  <p className="text-stone-600">
                    {ed.degree}, {ed.field}
                  </p>
                  <p className="text-[13px] text-stone-500 tabular-nums">Class of {ed.graduation_year}</p>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </article>
  );
}

export function CandidateProfileSkeleton() {
  return (
    <div className="mt-2" aria-busy="true" aria-label="Loading profile">
      <div className="rounded-2xl bg-white p-5 ring-1 ring-stone-200 ring-inset sm:p-7">
        <div className="flex gap-4 sm:gap-5">
          <Skeleton className="size-16 shrink-0 rounded-full sm:size-24" />
          <div className="flex-1 space-y-2.5">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-64 max-w-full" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
      </div>
      <div className="mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
