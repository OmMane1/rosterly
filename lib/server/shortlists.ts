import 'server-only';
// Shortlists, as the recruiter: RLS scopes every query to their company. A list of another company
// is invisible, so each id is looked up first and an unknown one is a 404, and every update or
// delete checks it changed exactly one row (CLAUDE.md § Security rules).
import { z } from 'zod';
import { Shortlist, type Created, type Ok } from '@/lib/shared/api';
import type { Recruiter } from './auth';
import { notFound, uuidParam } from './http';
import { CandidateRow, CARD_COLUMNS, candidateId, toCard } from './people';
import { check } from './supabase';

const LIST_COLUMNS = `id,name,created_at,updated_at,shortlist_people(added_at,candidates(${CARD_COLUMNS}))`;

const ShortlistRow = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  shortlist_people: z.array(z.object({ added_at: z.string(), candidates: CandidateRow })),
});

const IdRow = z.object({ id: z.string() });
const Renamed = z.object({ id: z.string(), name: z.string() });

const listNotFound = () => notFound('Shortlist not found.');

/** Newest addition first, then id, so the order is stable. */
function toShortlist(row: unknown): Shortlist {
  const { shortlist_people, ...list } = ShortlistRow.parse(row);
  const people = shortlist_people
    .sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at) || (a.candidates.id < b.candidates.id ? -1 : 1))
    .map((p) => toCard(p.candidates));
  return { ...list, people_count: people.length, people };
}

/** The explicit visibility lookup: the list's id if this company can see it, else a 404. */
async function visibleList(r: Recruiter, rawId: string): Promise<string> {
  const id = uuidParam(rawId, 'Shortlist');
  const row = check(await r.db.from('shortlists').select('id').eq('id', id).maybeSingle());
  if (!row) throw listNotFound();
  return id;
}

/** Exactly one row changed, or the list vanished in between (404). */
function one<T>(rows: T[]): T {
  const [row, ...rest] = rows;
  if (!row || rest.length > 0) throw listNotFound();
  return row;
}

export async function listShortlists(r: Recruiter): Promise<Shortlist[]> {
  const rows: unknown[] = check(await r.db.from('shortlists').select(LIST_COLUMNS).order('created_at', { ascending: false }).order('id'));
  return rows.map(toShortlist);
}

export async function getShortlist(r: Recruiter, rawId: string): Promise<Shortlist> {
  const id = uuidParam(rawId, 'Shortlist');
  const row = check(await r.db.from('shortlists').select(LIST_COLUMNS).eq('id', id).maybeSingle());
  if (!row) throw listNotFound();
  return toShortlist(row);
}

export async function createShortlist(r: Recruiter, name: string): Promise<Created> {
  // company_id and created_by come from the column defaults; the grant covers `name` only.
  return IdRow.parse(check(await r.db.from('shortlists').insert({ name }).select('id').single()));
}

export async function renameShortlist(r: Recruiter, rawId: string, name: string): Promise<{ id: string; name: string }> {
  const id = await visibleList(r, rawId);
  return one(z.array(Renamed).parse(check(await r.db.from('shortlists').update({ name }).eq('id', id).select('id,name'))));
}

export async function deleteShortlist(r: Recruiter, rawId: string): Promise<Ok> {
  const id = await visibleList(r, rawId);
  one(z.array(IdRow).parse(check(await r.db.from('shortlists').delete().eq('id', id).select('id'))));
  return { ok: true };
}

/** Adding someone already on the list changes nothing (`on conflict do nothing`). */
export async function addPerson(r: Recruiter, rawId: string, rawPersonId: string): Promise<Ok> {
  const id = await visibleList(r, rawId);
  const personId = candidateId(rawPersonId);
  const person = personId ? check(await r.db.from('candidates').select('id').eq('id', personId).maybeSingle()) : null;
  if (!personId || !person) throw notFound('Candidate not found.');
  check(
    await r.db
      .from('shortlist_people')
      .upsert({ shortlist_id: id, candidate_id: personId }, { onConflict: 'shortlist_id,candidate_id', ignoreDuplicates: true }),
  );
  return { ok: true };
}

/** Idempotent: removing someone who isn't on the list is still ok. */
export async function removePerson(r: Recruiter, rawId: string, rawPersonId: string): Promise<Ok> {
  const id = await visibleList(r, rawId);
  const personId = candidateId(rawPersonId);
  // An id that can't name a candidate can't be on the list either.
  if (personId) check(await r.db.from('shortlist_people').delete().eq('shortlist_id', id).eq('candidate_id', personId));
  return { ok: true };
}
