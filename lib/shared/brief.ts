// The recruiter's brief as the API accepts it (PLAN.md A14). Shared so the UI can show the same
// limit the server enforces.
import { z } from 'zod';
import { sanitizeText } from './sanitize';

export const MAX_BRIEF_LENGTH = 1000;

/**
 * Sanitised, trimmed, 1–1000 characters. Length counts code points, the way Postgres'
 * char_length does in the briefs CHECK, so the API and the database agree on the limit.
 */
export const Brief = z
  .string()
  .transform((s) => sanitizeText(s).trim())
  .pipe(
    z
      .string()
      .min(1, 'Describe who you are looking for.')
      .refine((s) => [...s].length <= MAX_BRIEF_LENGTH, `Keep the brief under ${MAX_BRIEF_LENGTH} characters.`),
  );
