import 'server-only';
// Start-up warm-up (PLAN.md M12). The first model call after a start pays for compiling the output
// schema, writing the prompt cache and opening the TLS connection (2.2–4.0 s, against ~1.2 s warm;
// measured in M6). One call at start-up pays it instead of the first recruiter. It goes straight to
// the parser: no database, no company, no search spent. Start-up never waits for it, and it never
// throws: a failure is one log line with a fixed message, never a key or a response.
import { LlmConfigError, LlmUnavailableError, parseBrief } from './parse-brief';

// Synthetic, like the prompt's few-shots (data/queries.json is held out).
const WARMUP_BRIEF = 'data engineers in Denver who know Spark';

export async function warmUp(): Promise<void> {
  try {
    const { ms, usage } = await parseBrief(WARMUP_BRIEF);
    const cache = usage.cache_write > 0 ? 'written' : usage.cache_read > 0 ? 'already warm' : 'not used';
    console.log(`[warmup] model ready in ${ms} ms (prompt cache ${cache})`);
  } catch (err) {
    // These two carry fixed messages ("the model key is not configured", …); anything else is named only.
    const why = err instanceof LlmConfigError || err instanceof LlmUnavailableError ? err.message : err instanceof Error ? err.name : typeof err;
    console.warn(`[warmup] skipped: ${why}. The first search will take a little longer.`);
  }
}
