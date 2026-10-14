// Runs the pinned Supabase CLI for the Makefile without ever showing a key on the terminal.
// `supabase start` (even when already running) prints the stack's status on stdout: a table with the
// secret key and the DB URL with its password, or, when the CLI detects an agent (CLAUDECODE,
// AI_AGENT, …), JSON that adds the service-role JWT and the JWT secret. So stdout goes only to
// .logs/supabase.log (git-ignored, mode 0600). Progress and errors arrive on stderr; those lines are
// shown, except any that could carry a credential and the CLI's own noise. In agent mode errors
// come as `{"_tag":"Error"}` lines on stdout instead, so their message is shown the same way.
//
//   node scripts/supabase-quiet.mjs start
//   node scripts/supabase-quiet.mjs migration up --local
//
// It runs node_modules/.bin/supabase directly, so a different CLI version is never fetched.
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'node_modules', '.bin', 'supabase');
const LOG = path.join(ROOT, '.logs', 'supabase.log');
const LOG_NAME = path.relative(ROOT, LOG);

// Only lines with nothing that could be a credential reach the terminal; the rest stay in the log.
const MAY_HOLD_KEY = /key|secret|token|passw|jwt|eyJ|sb_|whsec_|sk-ant-|:\/\/[^\s/]*@/i;
// The update notice (setup must keep the pinned version), the services our config.toml turns
// off, and Docker's per-layer pull progress.
const NOISE = [/new version of Supabase CLI/i, /recommend updating/i, /^Stopped services:/, /^[0-9a-f]{12}: /, /^Digest: sha256:/];

const args = process.argv.slice(2);
const label = `supabase ${args.join(' ')}`;

mkdirSync(path.dirname(LOG), { recursive: true });
const log = openSync(LOG, 'a', 0o600);
// openSync's mode applies only to a new file.
chmodSync(LOG, 0o600);
writeSync(log, `\n=== ${new Date().toISOString()} ${label}\n`);

console.log(`▸ ${label} (full output in ${LOG_NAME})`);
const started = performance.now();
const child = spawn(BIN, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (chunk) => writeSync(log, chunk));
child.stderr.on('data', (chunk) => writeSync(log, chunk));
const show = (raw) => {
  const line = raw.trim();
  if (line && !MAY_HOLD_KEY.test(line) && !NOISE.some((re) => re.test(line))) console.log(`  ${line}`);
};
readline.createInterface({ input: child.stderr }).on('line', show);
readline.createInterface({ input: child.stdout }).on('line', (raw) => {
  let message;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?._tag === 'Error') message = parsed.error?.message;
  } catch {
    return;
  }
  if (typeof message === 'string') show(message);
});

// A spawn failure can emit both 'error' and 'close'; only the first one reports. exitCode rather
// than exit(), so the last message is flushed even when stdout is a pipe.
let finished = false;
function finish(code, message) {
  if (finished) return;
  finished = true;
  closeSync(log);
  if (code === 0) console.log(message);
  else console.error(message);
  process.exitCode = code;
}

child.on('error', (err) => {
  finish(1, err.code === 'ENOENT' ? '✖ The pinned Supabase CLI is missing from node_modules. Run `npm ci` and retry.' : `✖ couldn't run ${label} (${err.code ?? err.name})`);
});

child.on('close', (code, signal) => {
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  if (code === 0) finish(0, `✔ ${label} (${secs} s)`);
  else finish(code || 1, `✖ ${label} failed (${signal ?? `exit ${code}`}). The full output, which can include local keys, is in ${LOG_NAME}.`);
});
