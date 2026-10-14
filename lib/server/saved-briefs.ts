import 'server-only';
// Saved searches, as the recruiter: RLS scopes every query to their company. The filters are kept
// as given (any object up to 16 KB, PLAN.md A12) and checked against the schema only when re-run.
import { z } from 'zod';
import { SavedBrief, type Created, type Ok } from '@/lib/shared/api';
import type { Recruiter } from './auth';
import { notFound, uuidParam } from './http';
import { check } from './supabase';

const IdRow = z.object({ id: z.string() });

export async function listSavedBriefs(r: Recruiter): Promise<SavedBrief[]> {
  const rows = check(await r.db.from('saved_briefs').select('id,brief,filters,created_at').order('created_at', { ascending: false }).order('id'));
  return z.array(SavedBrief).parse(rows);
}

export async function createSavedBrief(r: Recruiter, input: { brief: string; filters: Record<string, unknown> }): Promise<Created> {
  // company_id and created_by come from the column defaults; the grant covers brief and filters only.
  const row = check(await r.db.from('saved_briefs').insert({ brief: input.brief, filters: input.filters }).select('id').single());
  return IdRow.parse(row);
}

export async function deleteSavedBrief(r: Recruiter, rawId: string): Promise<Ok> {
  const gone = () => notFound('Saved search not found.');
  const id = uuidParam(rawId, 'Saved search');
  if (!check(await r.db.from('saved_briefs').select('id').eq('id', id).maybeSingle())) throw gone();
  const deleted = z.array(IdRow).parse(check(await r.db.from('saved_briefs').delete().eq('id', id).select('id')));
  if (deleted.length !== 1) throw gone();
  return { ok: true };
}
