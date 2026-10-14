// Preflight checks for `make setup` / `make dev`. Fails fast with a message that says what to do,
// because someone on a clean Mac must never be left guessing (RISKS.md § Prerequisite).
//
//   node scripts/check-env.mjs setup   Node 24, Docker running, Supabase ports free (or ours)
//   node scripts/check-env.mjs cli     the pinned Supabase CLI is installed and is 2.119.0
//   node scripts/check-env.mjs dev     as setup, plus port 3000 free and a warning for missing keys
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_NODE_MAJOR = 24;
const REQUIRED_CLI_VERSION = '2.119.0';
const SUPABASE_PORTS = [54321, 54322];
const APP_PORT = 3000;

const failures = [];
const fail = (msg) => failures.push(msg);
const warn = (msg) => console.warn(`! ${msg}`);

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== REQUIRED_NODE_MAJOR) {
    fail(`Node ${REQUIRED_NODE_MAJOR} is required, found v${process.versions.node}. Run \`nvm use\` (see .nvmrc) and retry.`);
  }
}

// Docker Desktop can miss a `docker info` for a moment while it is busy (seen once right after
// `make setup`), so a failure is retried for about 10 s before it counts.
const DOCKER_RETRY_MS = 10_000;
const DOCKER_RETRY_GAP_MS = 2_000;

async function checkDocker() {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 30_000 });
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        fail('Docker CLI not found. Install Docker Desktop and retry.');
        return false;
      }
      if (Date.now() - started >= DOCKER_RETRY_MS) {
        fail('Docker is not running. Start Docker Desktop, wait until it says "running", and retry.');
        return false;
      }
      if (attempt === 1) console.log('… Docker didn’t answer, checking again for a few seconds');
      await new Promise((resolve) => setTimeout(resolve, DOCKER_RETRY_GAP_MS));
    }
  }
}

function projectId() {
  const toml = readFileSync(path.join(ROOT, 'supabase/config.toml'), 'utf8');
  const match = toml.match(/^project_id\s*=\s*"([^"]+)"/m);
  if (!match?.[1]) throw new Error('supabase/config.toml has no project_id');
  return match[1];
}

// A connect probe, not a bind probe: on macOS a bind to 127.0.0.1 can succeed even while another
// process holds 0.0.0.0 on the same port, which would hide the conflict.
function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function dockerPortOwners() {
  try {
    const out = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], { encoding: 'utf8', timeout: 30_000 });
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name = '', ports = ''] = line.split('\t');
        return { name, ports };
      });
  } catch {
    return [];
  }
}

async function checkSupabasePorts(dockerUp) {
  const id = projectId();
  const owners = dockerUp ? dockerPortOwners() : [];
  for (const port of SUPABASE_PORTS) {
    if (!(await isListening(port))) continue;
    const owner = owners.find((c) => c.ports.includes(`:${port}->`));
    if (owner?.name.endsWith(`_${id}`)) continue; // our own stack from an earlier run
    if (owner?.name.startsWith('supabase_')) {
      const other = owner.name.replace(/^supabase_(kong|db)_/, '');
      fail(`Port ${port} is used by another Supabase project ("${other}"). Run \`supabase stop\` in that project (or stop its containers in Docker Desktop) and retry.`);
    } else if (owner) {
      fail(`Port ${port} is used by Docker container "${owner.name}". Stop it and retry.`);
    } else {
      fail(`Port ${port} is in use by another process. Supabase needs it; free it and retry.`);
    }
  }
}

async function checkAppPort() {
  if (await isListening(APP_PORT)) {
    fail(`Port ${APP_PORT} is in use (is \`make dev\` already running in another terminal?). Stop that process and retry.`);
  }
}

function checkCli() {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'supabase');
  let version;
  try {
    version = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 })
      .trim()
      .split('\n')[0];
  } catch {
    fail('The pinned Supabase CLI is missing from node_modules. Run `npm ci` and retry.');
    return;
  }
  if (version !== REQUIRED_CLI_VERSION) {
    fail(`Supabase CLI ${REQUIRED_CLI_VERSION} is required, found ${version}. Run \`npm ci\` to restore the pinned version.`);
  }
}

// Next reads the shell's environment and .env.local (the shell wins), so a key set in either is
// fine. Only whether a value is there is checked; no value is ever printed.
function namesSetInEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!existsSync(file)) return new Set();
  const set = new Set();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    const value = m?.[2]?.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (m?.[1] && value) set.add(m[1]);
  }
  return set;
}

function warnMissingKeys() {
  const inFile = namesSetInEnvLocal();
  const missing = (name) => !process.env[name]?.trim() && !inFile.has(name);
  if (missing('ANTHROPIC_API_KEY')) warn('ANTHROPIC_API_KEY is not set: new searches will fail until you export it (or add it to .env.local) and restart.');
  if (missing('STRIPE_WEBHOOK_SECRET')) warn('STRIPE_WEBHOOK_SECRET is not set: /api/billing/events will answer 500 until you export it (or add it to .env.local) and restart.');
  if (missing('STRIPE_SECRET_KEY')) warn('STRIPE_SECRET_KEY (a Stripe test-mode key) is not set: Upgrade will say checkout isn’t set up. Everything else works.');
}

const mode = process.argv[2];
switch (mode) {
  case 'setup': {
    checkNode();
    const dockerUp = await checkDocker();
    await checkSupabasePorts(dockerUp);
    break;
  }
  case 'cli':
    checkCli();
    break;
  case 'dev': {
    checkNode();
    const dockerUp = await checkDocker();
    await checkSupabasePorts(dockerUp);
    await checkAppPort();
    warnMissingKeys();
    break;
  }
  default:
    console.error('usage: node scripts/check-env.mjs setup|cli|dev');
    process.exit(2);
}

if (failures.length > 0) {
  for (const msg of failures) console.error(`✖ ${msg}`);
  process.exit(1);
}
console.log(`✔ environment ok (${mode})`);
