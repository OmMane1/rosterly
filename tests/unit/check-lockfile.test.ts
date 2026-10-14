import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = new URL('../../scripts/check-lockfile.mjs', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const tarball = (version: string) => ({ version, resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`, integrity: 'sha512-x' });

// The smallest lockfile the check accepts; each test removes or breaks one entry.
function lockfile(extra: Record<string, unknown> = {}) {
  return {
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/@supabase/cli-linux-x64': tarball(pkg.devDependencies.supabase!),
      'node_modules/@supabase/cli-darwin-arm64': tarball(pkg.devDependencies.supabase!),
      'node_modules/@next/swc-linux-x64-gnu': tarball(pkg.dependencies.next!),
      'node_modules/@next/swc-darwin-arm64': tarball(pkg.dependencies.next!),
      'node_modules/@esbuild/linux-x64': tarball('0.28.2'),
      'node_modules/@esbuild/darwin-arm64': tarball('0.28.2'),
      'node_modules/lightningcss-linux-x64-gnu': tarball('1.33.0'),
      'node_modules/lightningcss-darwin-arm64': tarball('1.33.0'),
      ...extra,
    },
  };
}

function check(lock: unknown) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'lockfile-')), 'package-lock.json');
  writeFileSync(file, JSON.stringify(lock));
  const run = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  return { status: run.status, output: run.stdout + run.stderr };
}

describe('check-lockfile', () => {
  it('passes when every linux-x64 native has a darwin-arm64 twin', () => {
    expect(check(lockfile()).status).toBe(0);
  });

  it('fails on a missing scoped twin such as @esbuild/darwin-arm64', () => {
    const result = check(lockfile({ 'node_modules/@esbuild/darwin-arm64': undefined }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('@esbuild/darwin-arm64');
  });

  it('fails on a missing hyphenated twin such as lightningcss-darwin-arm64', () => {
    const result = check(lockfile({ 'node_modules/lightningcss-darwin-arm64': undefined }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('lightningcss-darwin-arm64');
  });

  it('fails on a twin at another version or without an integrity hash', () => {
    expect(check(lockfile({ 'node_modules/@esbuild/darwin-arm64': tarball('0.27.0') })).status).toBe(1);
    expect(check(lockfile({ 'node_modules/@esbuild/darwin-arm64': { version: '0.28.2' } })).status).toBe(1);
  });

  it('fails without the Supabase CLI binary for darwin-arm64', () => {
    const result = check(lockfile({ 'node_modules/@supabase/cli-darwin-arm64': undefined }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('@supabase/cli-darwin-arm64');
  });
});
