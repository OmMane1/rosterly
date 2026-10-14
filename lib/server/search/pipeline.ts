import 'server-only';
// Brief → validated, grounded Filters (PLAN.md § 3.4 steps 4–5). The caller has already sanitised
// and length-checked the brief (lib/shared/brief.ts) and reserved the search; it maps
// LlmUnavailableError to 503 and LlmConfigError to 500, releasing the search in both cases.
import type { Filters } from '@/lib/shared/filters';
import { toFilters } from './llm-schema';
import { parseBrief, type LlmUsage, type ParseResult } from './parse-brief';
import { postprocess, type Conversion } from './postprocess';

export type Interpretation = {
  filters: Filters;
  /** ok, or why the model's answer couldn't be used (the search then has zero results). */
  outcome: 'ok' | Extract<ParseResult, { ok: false }>['reason'] | 'invalid';
  conversions: Conversion[];
  notes: string[];
  llm: { ms: number; usage: LlmUsage };
};

/** Shown when the model's answer can't be used: zero results, with a reason the UI can show. */
export const UNINTERPRETABLE: Filters = {
  unsupported: [{ text: 'This brief', reason: "Couldn't interpret this brief. Try describing a role, skills or a location." }],
};

export async function interpretBrief(brief: string, now: Date = new Date()): Promise<Interpretation> {
  const parsed = await parseBrief(brief, now);
  const llm = { ms: parsed.ms, usage: parsed.usage };
  if (!parsed.ok) return { filters: UNINTERPRETABLE, outcome: parsed.reason, conversions: [], notes: [], llm };
  try {
    return { ...postprocess(brief, toFilters(parsed.output)), outcome: 'ok', llm };
  } catch {
    // Output that passed the schema but can't form valid Filters (e.g. over 16 KB): never a 500.
    return { filters: UNINTERPRETABLE, outcome: 'invalid', conversions: [], notes: [], llm };
  }
}
