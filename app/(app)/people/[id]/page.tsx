'use client';
import { useParams, useSearchParams } from 'next/navigation';
import { UserX } from 'lucide-react';
import { Suspense } from 'react';
import { BackButton } from '@/components/candidates/back-button';
import { CandidateProfile, CandidateProfileSkeleton } from '@/components/candidates/candidate-profile';
import { parsePage, searchHref } from '@/components/search/results';
import { ErrorBanner } from '@/components/ui/banner';
import { EmptyState } from '@/components/ui/empty-state';
import { isApiError } from '@/lib/client/api';
import { usePerson, useSearchPage } from '@/lib/client/hooks/queries';
import { requestedSkills } from '@/lib/shared/chips';

const decode = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v; // a stray % is just an id that doesn't exist, which the API answers with a 404
  }
};

export default function PersonRoute() {
  return (
    <div className="mx-auto max-w-4xl">
      <Suspense fallback={<CandidateProfileSkeleton />}>
        <PersonScreen />
      </Suspense>
    </div>
  );
}

// The card that opened this profile says where it came from (?s=&page= or ?list=), so Back is
// labelled with its destination and survives a refresh.
function PersonScreen() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const s = params.get('s');
  const page = parsePage(params.get('page'));
  const list = params.get('list');
  const person = usePerson(decode(id));
  // Already cached when we came from the results; paging a search never uses one.
  const search = useSearchPage(s, page);
  const highlight = search.data ? requestedSkills(search.data.filters) : undefined;
  const back = s
    ? { href: searchHref(s, page), label: 'Back to results' }
    : list
      ? { href: `/shortlists/${encodeURIComponent(list)}`, label: 'Back to shortlist' }
      : { href: '/', label: 'Back to search' };

  return (
    <>
      <BackButton {...back} />
      {person.isPending ? (
        <CandidateProfileSkeleton />
      ) : person.isError ? (
        isApiError(person.error, 404) ? (
          <EmptyState icon={UserX} title="This person isn’t in the candidate data" className="mt-4">
            The link may be incomplete.
          </EmptyState>
        ) : (
          <ErrorBanner className="mt-4" title="Couldn’t load this profile" onRetry={() => person.refetch()} retrying={person.isFetching}>
            {person.error.message}
          </ErrorBanner>
        )
      ) : (
        <CandidateProfile person={person.data} highlight={highlight} />
      )}
    </>
  );
}
