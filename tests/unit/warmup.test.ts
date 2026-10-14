// The start-up warm-up (PLAN.md M12): one model call that start-up never waits for, that never
// throws, and whose log lines carry fixed text only (never a key or what the SDK said).
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from '@/instrumentation';
import { MODEL } from '@/lib/server/search/parse-brief';
import { warmUp } from '@/lib/server/search/warmup';

const create = vi.spyOn(Anthropic.Messages.prototype, 'create');
const log = vi.spyOn(console, 'log').mockImplementation(() => {});
const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
const printed = () => [...log.mock.calls, ...warn.mock.calls].flat().join('\n');

function reply(usage: { cache_read_input_tokens: number; cache_creation_input_tokens: number }) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text: '{}', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 200, ...usage },
  } as unknown as Anthropic.Message;
}

beforeEach(() => {
  create.mockReset();
  log.mockClear();
  warn.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('warmUp', () => {
  // First, before any test creates the parser's client with a key.
  it('skips with a fixed line when no model key is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await expect(warmUp()).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(printed()).toBe('[warmup] skipped: the model key is not configured. The first search will take a little longer.');
  });

  it('makes one model call with a brief that is not held-out data, and reports time and cache', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
    create.mockResolvedValueOnce(reply({ cache_read_input_tokens: 0, cache_creation_input_tokens: 8900 }) as never);
    await warmUp();
    expect(create).toHaveBeenCalledTimes(1);
    expect(printed()).toMatch(/^\[warmup\] model ready in \d+ ms \(prompt cache written\)$/);
    const [body] = create.mock.calls[0] ?? [];
    const held = (JSON.parse(readFileSync('data/queries.json', 'utf8')) as { brief: string }[]).map((q) => q.brief);
    expect(held.some((brief) => JSON.stringify(body).includes(brief))).toBe(false);
  });

  it('never throws, and never prints what the SDK or the error said', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
    create.mockRejectedValueOnce(new Anthropic.APIConnectionError({ message: 'sk-ant-leak in a socket error' }));
    await expect(warmUp()).resolves.toBeUndefined();
    create.mockRejectedValueOnce(new TypeError('sk-ant-leak in a bug'));
    await expect(warmUp()).resolves.toBeUndefined();
    expect(printed()).toBe(
      '[warmup] skipped: the model could not be reached. The first search will take a little longer.\n[warmup] skipped: TypeError. The first search will take a little longer.',
    );
  });
});

describe('register (instrumentation.ts)', () => {
  it('starts the warm-up and returns without waiting for it', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    create.mockReturnValueOnce(new Promise(() => {}) as never);
    expect(register()).toBeUndefined();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it('does nothing outside the Node.js runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    register();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(create).not.toHaveBeenCalled();
  });
});
