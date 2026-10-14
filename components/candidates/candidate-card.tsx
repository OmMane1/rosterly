'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import type { Card } from '@/lib/shared/api';
import { Avatar, CompanyLogo } from './avatar';
import { OpenToWork, SkillList } from './skill-list';

const Dot = () => (
  <span aria-hidden className="text-stone-300">
    ·
  </span>
);

/**
 * One person in a list. The whole card opens the profile (a stretched link); `action` (Shortlist,
 * Remove) sits above it. Phones give skills and the action their own full-width row, so names and
 * titles keep the width. `from` (a query string) tells the profile where Back goes and which
 * skills the search asked for.
 */
export function CandidateCard({ person, highlight, action, onOpen, from }: { person: Card; highlight?: Set<string>; action?: ReactNode; onOpen?: () => void; from?: string }) {
  return (
    <article className="group relative rounded-2xl bg-white p-4 ring-1 ring-stone-200 transition-shadow ring-inset hover:shadow-md hover:shadow-stone-200/60 hover:ring-stone-300 sm:p-5">
      <div className="flex gap-3.5 sm:gap-4">
        <Avatar src={person.avatar_url} name={person.full_name} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 leading-6">
                <Link
                  href={`/people/${encodeURIComponent(person.id)}${from ? `?${from}` : ''}`}
                  onClick={onOpen}
                  className="font-semibold outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-indigo-600"
                >
                  {person.full_name}
                </Link>
                {person.open_to_work && <OpenToWork />}
              </h3>
              <p className="truncate text-sm text-stone-800">{person.current_title}</p>
            </div>
            {action && <div className="relative z-10 hidden sm:block">{action}</div>}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] text-stone-600">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <CompanyLogo src={person.current_company_logo_url} name={person.current_company} />
              <span className="truncate">{person.current_company}</span>
            </span>
            <Dot />
            <span>
              {person.location.city}, {person.location.state}
            </span>
            <Dot />
            <span className="tabular-nums">{person.years_experience === 1 ? '1 yr' : `${person.years_experience} yrs`}</span>
          </p>
          <SkillList skills={person.skills} highlight={highlight} className="mt-3 hidden sm:flex" />
        </div>
      </div>
      <div className="mt-3 flex items-end gap-2 sm:hidden">
        <SkillList skills={person.skills} highlight={highlight} max={4} className="min-w-0 flex-1" />
        {action && <div className="relative z-10 shrink-0">{action}</div>}
      </div>
    </article>
  );
}

export function CandidateCardSkeleton() {
  return (
    <div aria-hidden className="rounded-2xl bg-white p-4 ring-1 ring-stone-200 ring-inset sm:p-5">
      <div className="flex gap-3.5 sm:gap-4">
        <Skeleton className="size-12 rounded-full" />
        <div className="flex-1 space-y-2 pt-0.5">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3.5 w-52 max-w-full" />
          <Skeleton className="h-3.5 w-44 max-w-full" />
          <div className="flex gap-1.5 pt-1.5">
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-6 w-14" />
          </div>
        </div>
      </div>
    </div>
  );
}

export const CandidateListSkeleton = ({ count = 4 }: { count?: number }) => (
  <div className="space-y-3" aria-busy="true" aria-label="Loading people">
    {Array.from({ length: count }, (_, i) => (
      <CandidateCardSkeleton key={i} />
    ))}
  </div>
);
