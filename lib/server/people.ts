import 'server-only';
// Candidates, read as the recruiter (RLS: recruiters only). Shared by every company.
import { z } from 'zod';
import { Education, Experience, Person, type Card } from '@/lib/shared/api';
import { sanitizeText } from '@/lib/shared/sanitize';
import type { Recruiter } from './auth';
import { notFound } from './http';
import { check } from './supabase';

/** Same limit as the candidates.id CHECK: a longer id can't exist, so it isn't looked up. */
const MAX_ID_LENGTH = 64;

/** The candidates columns a card needs, as PostgREST select syntax. */
export const CARD_COLUMNS =
  'id,full_name,avatar_url,headline,current_title,current_company,current_company_logo_url,role,seniority,years_experience,city,state,country,open_to_work,skills';

export const CandidateRow = z.object({
  id: z.string(),
  full_name: z.string(),
  avatar_url: z.string(),
  headline: z.string(),
  current_title: z.string(),
  current_company: z.string(),
  current_company_logo_url: z.string(),
  role: z.string(),
  seniority: z.string(),
  years_experience: z.number(),
  city: z.string(),
  state: z.string(),
  country: z.string(),
  open_to_work: z.boolean(),
  skills: z.array(z.string()),
});

/** A table row → the card shape (location nested, as in candidates.json). */
export function toCard({ city, state, country, ...row }: z.infer<typeof CandidateRow>): Card {
  const { skills, open_to_work, ...head } = row;
  return { ...head, location: { city, state, country }, open_to_work, skills };
}

const PersonRow = CandidateRow.extend({
  candidate_experiences: z.array(Experience.extend({ position: z.number() })),
  candidate_education: z.array(Education.extend({ position: z.number() })),
});

const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;

/**
 * A candidate id from the URL, sanitised like every other input (a NUL would otherwise reach
 * Postgres and fail as 22P05), or null when it can't name a candidate.
 */
export function candidateId(raw: string): string | null {
  const id = sanitizeText(raw);
  return id.length > 0 && id.length <= MAX_ID_LENGTH ? id : null;
}

export async function getPerson(r: Recruiter, rawId: string): Promise<Person> {
  const id = candidateId(rawId);
  if (!id) throw notFound('Candidate not found.');
  const row = check(
    await r.db
      .from('candidates')
      .select(
        `${CARD_COLUMNS},candidate_experiences(position,title,company,company_logo_url,company_type,start_year,end_year,description),candidate_education(position,school,degree,field,graduation_year)`,
      )
      .eq('id', id)
      .maybeSingle(),
  );
  if (!row) throw notFound('Candidate not found.');
  const { candidate_experiences, candidate_education, ...candidate } = PersonRow.parse(row);
  // experiences[0] is the current job, as in the data; zod drops `position` from the output.
  return Person.parse({
    ...toCard(candidate),
    experiences: candidate_experiences.sort(byPosition),
    education: candidate_education.sort(byPosition),
  });
}
