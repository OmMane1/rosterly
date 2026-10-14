import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  engines: { node: string };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('toolchain', () => {
  it('pins every dependency to an exact version', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const loose = Object.entries(all).filter(([, v]) => !/^\d+\.\d+\.\d+$/.test(v));
    expect(loose).toEqual([]);
  });

  it('pins the versions the output contract requires', () => {
    expect(pkg.devDependencies.supabase).toBe('2.119.0');
    expect(pkg.dependencies.next).toMatch(/^16\./);
    expect(pkg.engines.node).toBe('24.x');
    expect(readFileSync(new URL('../../.nvmrc', import.meta.url), 'utf8').trim()).toBe('24');
  });

  it('runs on Node 24', () => {
    expect(process.versions.node.split('.')[0]).toBe('24');
  });
});
