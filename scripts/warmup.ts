// The start-up warm-up, run by `make dev` in the background before anything else (PLAN.md M12).
// With the model's caches cold (a new machine, or an hour idle), the first call compiles the output
// schema and writes the prompt cache: 3.3–3.9 s. The server's own warm-up (instrumentation.ts) can
// only start about 0.3 s before it's ready, so a search sent straight away would still overlap it.
// Started here, the call runs alongside Supabase's start and the build check (~4–5 s) instead.
// It calls the model only: no database, no company, no search spent. Reads .env.local like Next
// does (an exported value wins), stays quiet when there's no key (check-env already warns), and
// never prints a key.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { warmUp } from '@/lib/server/search/warmup';

const ROOT = path.resolve(import.meta.dirname, '..');
if (existsSync(path.join(ROOT, '.env.local'))) process.loadEnvFile(path.join(ROOT, '.env.local'));
if (process.env.ANTHROPIC_API_KEY?.trim()) await warmUp();
