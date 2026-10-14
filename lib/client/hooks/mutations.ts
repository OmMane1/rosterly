'use client';
// Writes. Shortlist ticks are optimistic (the checkbox answers at once and rolls back on failure);
// everything else refetches what it changed. Opening Upgrade on a 402 is left to the caller, which
// knows what the recruiter was trying to do.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Card, Shortlist } from '@/lib/shared/api';
import type { Filters } from '@/lib/shared/filters';
import { api, isApiError } from '../api';
import { keys, rememberLimit, rememberSearch } from './queries';

export function useNewSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (brief: string) => api.search(brief),
    onSuccess: (res, brief) => rememberSearch(qc, brief, res),
    onError: (err) => isApiError(err, 402) && rememberLimit(qc),
  });
}

export type RefineInput = { brief: string; filters: Filters | Record<string, unknown>; source: 'edit' | 'saved' };

/** Chip edits and saved re-runs: a new result set from the recruiter's own filters. */
export function useRefine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ brief, filters, source }: RefineInput) => api.refine(brief, filters, source),
    onSuccess: (res, { brief }) => rememberSearch(qc, brief, res),
    onError: (err) => isApiError(err, 402) && rememberLimit(qc),
  });
}

type Membership = { listId: string; person: Card; add: boolean };

function withMembership(list: Shortlist, { person, add }: Membership): Shortlist {
  const has = list.people.some((p) => p.id === person.id);
  if (has === add) return list;
  // The server lists the newest addition first.
  const people = add ? [person, ...list.people] : list.people.filter((p) => p.id !== person.id);
  return { ...list, people, people_count: people.length };
}

export function useShortlistMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, person, add }: Membership) => (add ? api.addToShortlist(listId, person.id) : api.removeFromShortlist(listId, person.id)),
    onMutate: async (m) => {
      await qc.cancelQueries({ queryKey: keys.shortlists });
      const all = qc.getQueryData<Shortlist[]>(keys.shortlists);
      const one = qc.getQueryData<Shortlist>(keys.shortlist(m.listId));
      qc.setQueryData<Shortlist[]>(keys.shortlists, (lists) => lists?.map((l) => (l.id === m.listId ? withMembership(l, m) : l)));
      qc.setQueryData<Shortlist>(keys.shortlist(m.listId), (l) => l && withMembership(l, m));
      return { all, one };
    },
    onError: (_err, m, saved) => {
      qc.setQueryData(keys.shortlists, saved?.all);
      qc.setQueryData(keys.shortlist(m.listId), saved?.one);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.shortlists }),
  });
}

export function useCreateShortlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createShortlist(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.shortlists }),
  });
}

export function useRenameShortlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameShortlist(id, name),
    onSuccess: ({ id, name }) => {
      qc.setQueryData<Shortlist>(keys.shortlist(id), (l) => l && { ...l, name });
      return qc.invalidateQueries({ queryKey: keys.shortlists });
    },
  });
}

export function useDeleteShortlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteShortlist(id),
    onSuccess: (_ok, id) => {
      qc.setQueryData<Shortlist[]>(keys.shortlists, (lists) => lists?.filter((l) => l.id !== id));
      qc.removeQueries({ queryKey: keys.shortlist(id) });
      return qc.invalidateQueries({ queryKey: keys.shortlists, exact: true });
    },
  });
}

export function useSaveBrief() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ brief, filters }: { brief: string; filters: Filters }) => api.saveBrief(brief, filters),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.saved }),
  });
}

export function useDeleteSavedBrief() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSavedBrief(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.saved }),
  });
}
