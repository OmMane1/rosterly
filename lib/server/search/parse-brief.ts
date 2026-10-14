import 'server-only';
// One Claude Haiku 5.5 call: brief → LlmFilters (PLAN.md § 3.4, A1, A15). The output is constrained
// by the enum-only JSON schema, then validated again with zod before anything uses it.
import Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey, MissingEnvError } from '@/lib/server/env';
import { LlmFilters, llmJsonSchema } from './llm-schema';
import { briefMessage, dateLine, SYSTEM_PROMPT } from './prompt';

export const MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 8_000;
const MAX_RETRIES = 1;
const MAX_TOKENS = 1_000;
// About the p95 of a plain call (M12): a second request starts for ~5% of searches.
export const HEDGE_AFTER_MS = 2_000;

/** Network error, timeout, 429 or 5xx: the caller answers 503 and gives the search back. */
export class LlmUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LlmUnavailableError';
  }
}

/** Missing or rejected key, or a request the API refuses: our bug or config, so 500 (search given back). */
export class LlmConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LlmConfigError';
  }
}

export type LlmUsage = { input: number; output: number; cache_read: number; cache_write: number };

/**
 * `ok: false` is an answer the model gave that we can't use (a refusal, a cut-off, or output that
 * fails validation). It still counts as a search: it ends as zero results (A15).
 */
export type ParseResult =
  | { ok: true; output: LlmFilters; ms: number; usage: LlmUsage }
  | { ok: false; reason: 'refusal' | 'max_tokens' | 'unparseable'; ms: number; usage: LlmUsage };

let client: Anthropic | undefined;

function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: anthropicApiKey(), timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES });
  return client;
}

function usageOf(u: Anthropic.Usage): LlmUsage {
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cache_read: u.cache_read_input_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? 0,
  };
}

function classify(err: unknown): Error {
  if (err instanceof MissingEnvError) return new LlmConfigError('the model key is not configured');
  // Connection errors include timeouts; both are worth retrying later.
  if (err instanceof Anthropic.APIConnectionError) return new LlmUnavailableError('the model could not be reached', { cause: err });
  if (err instanceof Anthropic.RateLimitError) return new LlmUnavailableError('the model is rate limited', { cause: err });
  if (err instanceof Anthropic.InternalServerError) return new LlmUnavailableError('the model is unavailable', { cause: err });
  if (err instanceof Anthropic.APIError) return new LlmConfigError(`the model rejected the request (${err.status ?? 'no status'})`, { cause: err });
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * The call, hedged (M12, DECISIONS.md): about 1 call in 100 stalls or crawls (6.8–10.5 s measured)
 * while the rest answer in ~2 s. If the first request hasn't answered after HEDGE_AFTER_MS, an
 * identical second one starts; the first answer wins and the other is aborted. A request that fails
 * before the hedge starts is not hedged (its SDK retry has run), so errors surface as before; once
 * both run, the call fails only when both have, with the first request's error.
 */
function hedged(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  const client = anthropic();
  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    const errors: unknown[] = [];
    let failed = 0;
    let settled = false;
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      for (const c of controllers) c.abort();
    };
    const start = () => {
      const controller = new AbortController();
      const attempt = controllers.push(controller) - 1;
      client.messages.create(body, { signal: controller.signal }).then(
        (message) => {
          if (settled) return;
          settle();
          resolve(message);
        },
        (err: unknown) => {
          if (settled) return;
          errors[attempt] = err;
          failed += 1;
          if (failed < controllers.length) return;
          settle();
          reject(errors[0]);
        },
      );
    };
    const timer = setTimeout(start, HEDGE_AFTER_MS);
    start();
  });
}

export async function parseBrief(brief: string, now: Date = new Date()): Promise<ParseResult> {
  const started = performance.now();
  let response: Anthropic.Message;
  try {
    response = await hedged({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: llmJsonSchema() } },
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: dateLine(now) },
      ],
      messages: [{ role: 'user', content: briefMessage(brief) }],
    });
  } catch (err) {
    throw classify(err);
  }
  const ms = Math.round(performance.now() - started);
  const usage = usageOf(response.usage);
  if (response.stop_reason === 'refusal') return { ok: false, reason: 'refusal', ms, usage };
  if (response.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens', ms, usage };

  const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unparseable', ms, usage };
  }
  const parsed = LlmFilters.safeParse(json);
  return parsed.success ? { ok: true, output: parsed.data, ms, usage } : { ok: false, reason: 'unparseable', ms, usage };
}
