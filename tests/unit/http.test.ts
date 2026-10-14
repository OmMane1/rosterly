// lib/server/http.ts: the one place errors become responses, plus body and parameter parsing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, errorResponse, handler, MAX_BODY_BYTES, pageParam, parseInput, readJsonObject, toApiError, uuidParam } from '@/lib/server/http';
import { DbError } from '@/lib/server/supabase';

const caught = async (p: Promise<unknown>): Promise<ApiError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
};
const thrown = (fn: () => unknown): ApiError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
};

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/x', { method: 'POST', body, headers, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) });

afterEach(() => vi.restoreAllMocks());

describe('Postgres error mapping', () => {
  it.each([
    ['22P02', 404, 'not_found'],
    ['23503', 404, 'not_found'],
    ['42501', 404, 'not_found'],
    ['23514', 400, 'invalid_request'],
    ['P0402', 402, 'search_limit_reached'],
    ['P0429', 429, 'rate_limited'],
    ['PGRST301', 401, 'unauthorized'],
  ])('%s → %i %s', (code, status, apiCode) => {
    const e = toApiError(new DbError(code, 'detail from the database'));
    expect([e.status, e.code]).toEqual([status, apiCode]);
  });

  it('402 carries the plan next to the error', async () => {
    const res = errorResponse(new DbError('P0402', 'no searches left'));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: { code: 'search_limit_reached', message: expect.any(String) },
      plan: 'free',
      searches_remaining: 0,
    });
  });

  it('429 says when to retry and keeps responses uncached', async () => {
    const res = errorResponse(new DbError('P0429', 'too many searches'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: { code: 'rate_limited', message: expect.any(String) } });
  });

  it('an unknown code or a plain error is a 500 that hides the detail', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const err of [new DbError('XX000', 'secret detail'), new Error('secret detail'), 'a string']) {
      const res = errorResponse(err);
      expect(res.status).toBe(500);
      const body: unknown = await res.json();
      expect(body).toEqual({ error: { code: 'internal', message: expect.any(String) } });
      expect(JSON.stringify(body)).not.toContain('secret detail');
    }
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('every error body is exactly { error: { code, message } } and never cached', async () => {
    const res = errorResponse(new ApiError(404, 'not_found', 'Shortlist not found.'));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Shortlist not found.' } });
  });

  it('handler turns anything thrown into a response', async () => {
    const route = handler(async () => {
      throw new DbError('42501', 'row-level security');
    });
    expect((await route()).status).toBe(404);
  });
});

describe('readJsonObject', () => {
  it('reads a JSON object', async () => {
    expect(await readJsonObject(post(JSON.stringify({ brief: 'x' })))).toEqual({ brief: 'x' });
  });

  it.each([
    ['empty', '', 'invalid_json'],
    ['not JSON', 'brief=x', 'invalid_json'],
    ['an array', '[]', 'invalid_body'],
    ['null', 'null', 'invalid_body'],
    ['a string', '"x"', 'invalid_body'],
    ['a number', '1', 'invalid_body'],
  ])('%s → 400 %s', async (_, body, code) => {
    const e = await caught(readJsonObject(post(body)));
    expect([e.status, e.code]).toEqual([400, code]);
  });

  it('rejects a declared length over the cap without reading', async () => {
    const e = await caught(readJsonObject(post('{}', { 'content-length': String(MAX_BODY_BYTES + 1) })));
    expect([e.status, e.code]).toEqual([400, 'body_too_large']);
  });

  it('stops reading a streamed body once it passes the cap', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(8 * 1024).fill(32));
        if (pulled > 100) controller.close();
      },
    });
    const e = await caught(readJsonObject(post(stream)));
    expect([e.status, e.code]).toEqual([400, 'body_too_large']);
    expect(pulled).toBeLessThan(10);
  });

  it('accepts a body of exactly the cap', async () => {
    const body = JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES - 10) });
    expect(new TextEncoder().encode(body).length).toBe(MAX_BODY_BYTES);
    expect(await readJsonObject(post(body))).toHaveProperty('pad');
  });
});

describe('pageParam', () => {
  const page = (query: string) => pageParam(new Request(`http://localhost/api/search/x${query}`));

  it.each([
    ['', 1],
    ['?page=1', 1],
    ['?page=2', 2],
    ['?page=007', 7],
    ['?page=10000', 10000],
  ])('%s → %i', (query, expected) => {
    expect(page(query)).toBe(expected);
  });

  it.each(['?page=0', '?page=-1', '?page=1.5', '?page=abc', '?page=', '?page=10001', '?page=1e3', '?page=%201', '?page=99999999999'])('%s → 400', (query) => {
    const e = thrown(() => page(query));
    expect([e.status, e.code]).toEqual([400, 'invalid_page']);
  });
});

describe('uuidParam', () => {
  it('accepts a uuid in any case and lowercases it', () => {
    expect(uuidParam('0D3C2D9E-5B1A-4C4F-9E2A-1B2C3D4E5F60', 'Shortlist')).toBe('0d3c2d9e-5b1a-4c4f-9e2a-1b2c3d4e5f60');
  });

  it.each(['nope', '', '0d3c2d9e5b1a4c4f9e2a1b2c3d4e5f60x', "1' or '1'='1"])('%j is a 404', (id) => {
    const e = thrown(() => uuidParam(id, 'Shortlist'));
    expect([e.status, e.message]).toEqual([404, 'Shortlist not found.']);
  });
});

describe('parseInput', () => {
  it('reports the first problem with its path', () => {
    const e = thrown(() => parseInput(z.object({ name: z.string().min(1, 'Name the list.') }), { name: '' }, 'invalid_name'));
    expect([e.status, e.code, e.message]).toEqual([400, 'invalid_name', 'name: Name the list.']);
  });
});
