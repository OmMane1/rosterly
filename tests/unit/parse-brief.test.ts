// The model call with the SDK's transport replaced: A15's outcomes (503 / 500 / zero results) and
// the request shape, without a network or a key.
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { llmJsonSchema } from '@/lib/server/search/llm-schema';
import { HEDGE_AFTER_MS, LlmConfigError, LlmUnavailableError, MODEL, parseBrief } from '@/lib/server/search/parse-brief';
import { interpretBrief, UNINTERPRETABLE } from '@/lib/server/search/pipeline';
import { SYSTEM_PROMPT } from '@/lib/server/search/prompt';
import { emptyLlm } from './helpers/llm';

const create = vi.spyOn(Anthropic.Messages.prototype, 'create');

function reply(text: string, stop_reason: Anthropic.StopReason = 'end_turn') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text, citations: null }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 200, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

// messages.create returns an APIPromise; resolving to a plain value is enough for `await`.
const answer = (value: Anthropic.Message) => create.mockResolvedValueOnce(value as never);
const fail = (err: Error) => create.mockRejectedValueOnce(err);

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('parseBrief', () => {
  it('sends the cached prompt, the schema, effort low and no thinking', async () => {
    answer(reply(JSON.stringify(emptyLlm({ roles: ['Recruiter'] }))));
    const result = await parseBrief('recruiters', new Date('2026-10-08T12:00:00Z'));
    expect(result).toMatchObject({ ok: true, output: { roles: ['Recruiter'] }, usage: { cache_read: 9000 } });
    const [body, options] = create.mock.calls[0] ?? [];
    expect(body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 1000,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: llmJsonSchema() } },
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: "Today's date is 2026-10-08." },
      ],
      messages: [{ role: 'user', content: '<brief>"recruiters"</brief>' }],
    });
    expect(body).not.toHaveProperty('temperature');
    expect(options).toEqual({ signal: expect.any(AbortSignal) });
  });

  it.each([
    ['a refusal', reply('', 'refusal'), 'refusal'],
    ['a max_tokens cut-off', reply('{"unsupported": [', 'max_tokens'), 'max_tokens'],
    ['text that is not JSON', reply('I cannot help with that.'), 'unparseable'],
    ['JSON that fails the schema', reply(JSON.stringify({ ...emptyLlm(), cities: ['London'] })), 'unparseable'],
  ])('reports %s as an unusable answer, not an error', async (_, message, reason) => {
    answer(message);
    await expect(parseBrief('anything')).resolves.toMatchObject({ ok: false, reason });
  });

  const headers = new Headers();
  it.each([
    ['a connection error', new Anthropic.APIConnectionError({ message: 'socket hang up' })],
    ['a timeout', new Anthropic.APIConnectionTimeoutError()],
    ['a 429', Anthropic.APIError.generate(429, undefined, 'rate limited', headers)],
    ['a 500', Anthropic.APIError.generate(500, undefined, 'server error', headers)],
    ['a 529', Anthropic.APIError.generate(529, undefined, 'overloaded', headers)],
  ])('maps %s to LlmUnavailableError (503)', async (_, err) => {
    fail(err);
    await expect(parseBrief('anything')).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it.each([
    ['an invalid key', Anthropic.APIError.generate(401, undefined, 'invalid x-api-key', headers)],
    ['a forbidden key', Anthropic.APIError.generate(403, undefined, 'forbidden', headers)],
    ['a rejected request', Anthropic.APIError.generate(400, undefined, 'bad schema', headers)],
    ['an unknown model', Anthropic.APIError.generate(404, undefined, 'not found', headers)],
  ])('maps %s to LlmConfigError (500)', async (_, err) => {
    fail(err);
    await expect(parseBrief('anything')).rejects.toBeInstanceOf(LlmConfigError);
  });

  it('never sends a request without a key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.resetModules();
    const fresh = await import('@/lib/server/search/parse-brief');
    await expect(fresh.parseBrief('anything')).rejects.toBeInstanceOf(fresh.LlmConfigError);
    expect(create).not.toHaveBeenCalled();
  });
});

// A request the test settles by hand; aborting it rejects it the way the SDK does.
function held() {
  let settle: { resolve: (m: Anthropic.Message) => void; reject: (e: Error) => void } | undefined;
  let signal: AbortSignal | undefined;
  create.mockImplementationOnce(((_body: unknown, options?: { signal?: AbortSignal }) => {
    signal = options?.signal;
    return new Promise<Anthropic.Message>((resolve, reject) => {
      settle = { resolve, reject };
      signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
    });
  }) as never);
  return {
    resolve: (m: Anthropic.Message) => settle?.resolve(m),
    reject: (e: Error) => settle?.reject(e),
    aborted: () => signal?.aborted ?? false,
  };
}

describe('parseBrief hedging (M12)', () => {
  const ok = () => reply(JSON.stringify(emptyLlm({ roles: ['Recruiter'] })));
  const overloaded = () => Anthropic.APIError.generate(529, undefined, 'overloaded', new Headers());
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends one request when the answer comes in time', async () => {
    answer(ok());
    await expect(parseBrief('recruiters')).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 3);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('starts an identical second request after HEDGE_AFTER_MS, uses the first answer and aborts the other', async () => {
    const first = held();
    const second = held();
    const result = parseBrief('recruiters');
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS - 1);
    expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
    second.resolve(ok());
    await expect(result).resolves.toMatchObject({ ok: true, output: { roles: ['Recruiter'] } });
    expect(first.aborted()).toBe(true);
    expect(second.aborted()).toBe(true); // aborting a finished request is a no-op
  });

  it('still uses the first request when it answers after the hedge started', async () => {
    const first = held();
    const second = held();
    const result = parseBrief('recruiters');
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    first.resolve(ok());
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(second.aborted()).toBe(true);
  });

  it('does not hedge a request that failed before the hedge was due', async () => {
    fail(overloaded());
    await expect(parseBrief('recruiters')).rejects.toBeInstanceOf(LlmUnavailableError);
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 3);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('waits for the other request when one fails, and fails only when both have', async () => {
    const first = held();
    const second = held();
    const result = parseBrief('recruiters');
    const outcome = result.then(
      () => 'resolved',
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    second.reject(Anthropic.APIError.generate(401, undefined, 'invalid x-api-key', new Headers()));
    await vi.advanceTimersByTimeAsync(0);
    first.reject(new Anthropic.APIConnectionError({ message: 'socket hang up' }));
    // The first request's error decides: a connection error is a 503, not the hedge's 401.
    expect(await outcome).toBeInstanceOf(LlmUnavailableError);

    const third = held();
    const fourth = held();
    const next = parseBrief('recruiters');
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
    third.reject(overloaded());
    await vi.advanceTimersByTimeAsync(0);
    fourth.resolve(ok());
    await expect(next).resolves.toMatchObject({ ok: true });
  });
});

describe('interpretBrief', () => {
  it('converts, grounds and validates the answer', async () => {
    answer(reply(JSON.stringify(emptyLlm({ roles: ['Backend Engineer'], cities: ['New York'], ignored: ['rockstar'] }))));
    const r = await interpretBrief('rockstar backend engineers in London');
    expect(r.outcome).toBe('ok');
    expect(r.filters).toEqual({
      roles: ['Backend Engineer'],
      unsupported: [{ text: 'New York', reason: "Couldn't match “New York” to anything in the brief." }],
      ignored: ['rockstar'],
    });
    expect(r.conversions).toHaveLength(1);
    expect(r.llm).toEqual({ ms: expect.any(Number), usage: { input: 40, output: 200, cache_read: 9000, cache_write: 0 } });
  });

  it('turns an unusable answer into a zero-result search with a reason', async () => {
    answer(reply('', 'refusal'));
    await expect(interpretBrief('anything')).resolves.toMatchObject({ outcome: 'refusal', filters: UNINTERPRETABLE });
  });

  it('lets transport errors through for the caller to map', async () => {
    fail(new Anthropic.APIConnectionError({ message: 'down' }));
    await expect(interpretBrief('anything')).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
