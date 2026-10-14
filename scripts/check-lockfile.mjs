// We develop on x64 Linux, but many people run it on darwin-arm64. npm only installs a platform binary
// that the lockfile lists, so a lockfile missing the darwin-arm64 entries breaks `npm ci` or the
// Supabase CLI on an Apple Silicon Mac. This asserts every native package we resolve for linux-x64 has
// a darwin-arm64 twin at the same version, with a tarball URL and integrity hash.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// An explicit path is for tests; the real check reads the repo's lockfile.
const lockPath = process.argv[2] ?? path.join(ROOT, 'package-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const packages = lock.packages ?? {};

const errors = [];
const checked = [];

function entry(name) {
  return packages[`node_modules/${name}`];
}

function requireEntry(name, version) {
  const e = entry(name);
  if (!e) {
    errors.push(`${name}@${version} is missing`);
    return;
  }
  if (e.version !== version) errors.push(`${name} is ${e.version}, expected ${version}`);
  if (!e.resolved || !e.integrity) errors.push(`${name} has no resolved URL or integrity hash`);
  checked.push(`${name}@${e.version}`);
}

if (lock.lockfileVersion !== 3) errors.push(`lockfileVersion is ${lock.lockfileVersion}, expected 3`);

// The two a Mac install cannot do without, named explicitly so a rename upstream can't hide them.
requireEntry('@supabase/cli-darwin-arm64', pkg.devDependencies.supabase);
requireEntry('@next/swc-darwin-arm64', pkg.dependencies.next);

// Every other native package (Tailwind oxide, lightningcss, esbuild, rolldown, sharp, …).
// The separator is `-` (lightningcss-linux-x64-gnu) or `/` (@esbuild/linux-x64).
const LINUX_X64 = /([-/])linux-x64(-gnu|-musl)?$/;
for (const [key, e] of Object.entries(packages)) {
  const name = key.replace(/^.*node_modules\//, '');
  if (!LINUX_X64.test(name) || /-musl$/.test(name)) continue;
  const twin = name.replace(LINUX_X64, '$1darwin-arm64');
  const twinKey = key.replace(name, twin);
  const t = packages[twinKey];
  if (!t) errors.push(`${twin} (twin of ${name}@${e.version}) is missing`);
  else if (t.version !== e.version) errors.push(`${twin} is ${t.version}, but ${name} is ${e.version}`);
  else if (!t.resolved || !t.integrity) errors.push(`${twin} has no resolved URL or integrity hash`);
  else if (!checked.includes(`${twin}@${t.version}`)) checked.push(`${twin}@${t.version}`);
}

if (errors.length > 0) {
  for (const msg of errors) console.error(`✖ ${msg}`);
  console.error('Regenerate the lockfile from scratch: rm -rf node_modules package-lock.json && npm install');
  process.exit(1);
}
console.log(`✔ lockfile has darwin-arm64 packages:\n  ${checked.join('\n  ')}`);
