// `make dev` serves the production build (PLAN.md A13). Rebuild only when an input is newer than the
// last build, so a plain `make setup && make dev` starts at once.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUTS = ['app', 'components', 'lib', 'public', 'instrumentation.ts', 'next.config.ts', 'postcss.config.mjs', 'tsconfig.json', 'package-lock.json', '.env.local'];
const BUILD_ID = path.join(ROOT, '.next', 'BUILD_ID');

function newestMtime(p) {
  if (!existsSync(p)) return 0;
  const s = statSync(p);
  if (!s.isDirectory()) return s.mtimeMs;
  let newest = s.mtimeMs;
  for (const child of readdirSync(p)) newest = Math.max(newest, newestMtime(path.join(p, child)));
  return newest;
}

const built = existsSync(BUILD_ID) ? statSync(BUILD_ID).mtimeMs : 0;
const newest = Math.max(...INPUTS.map((p) => newestMtime(path.join(ROOT, p))));

if (built > newest) {
  console.log('✔ build is up to date');
} else {
  console.log(built === 0 ? 'No build found, building…' : 'Sources changed since the last build, rebuilding…');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
}
