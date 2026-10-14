# CLAUDE.md: rules for anyone (human or agent) working in this repo

## Project

This repo is a small recruiter app built on Next.js 16 and a local Supabase. A recruiter searches 5,000 candidates in plain English and corrects the filters the app understood. They can view a candidate, shortlist candidates and save searches. Two companies (asterwell and glenfold) are fully separated, the free plan allows 1 search in total, and the plan state comes only from signed Stripe webhook events.

- **Docs:** `PLAN.md` has the milestones, design reference and API contract. `RISKS.md` lists what could go wrong and how the design prevents it. `DECISIONS.md` is the decision log (see Workflow).

## Output contract (never change it without updating the contract tests)

- `make setup` installs dependencies, starts local Supabase, applies migrations, loads all of `data/candidates.json`, seeds the companies and recruiters, and builds the app.
- `make dev` serves the app on http://localhost:3000.
- Both run on a clean macOS (Apple Silicon) machine with Docker Desktop, with no manual steps.
- Seeded logins (Supabase email/password):
  - `recruiter@asterwell.test` / `rosterly-demo` for asterwell
  - `recruiter@glenfold.test` / `rosterly-demo` for glenfold
- **Config comes from environment variables only.** Whoever runs the app exports `ANTHROPIC_API_KEY` and `STRIPE_WEBHOOK_SECRET` in their shell, plus `STRIPE_SECRET_KEY` (a Stripe **test-mode** key) if Upgrade should open Stripe Checkout. Without that key, Upgrade says checkout isn't set up and everything else works. Everything else (Supabase URL and keys) is generated locally by `make setup` into `.env.local`.
  - **For local development these keys live in the git-ignored `.env.local`, on purpose:** Om adds them there by hand, so Claude Code never has `ANTHROPIC_API_KEY` in its own environment. Next reads both the shell and `.env.local` (an exported value wins), and so do the scripts that call the model or sign webhooks. `make dev` warns only when a key is set in neither, and never prints a value.
  - No script, test or agent writes any of these keys into any file, prints it, or reads `.env.local` aloud (check names, never values).
- The routes, request and response shapes, and status codes are in **PLAN.md § API contract**. The contract tests (`tests/e2e/contract.test.ts`) mirror it.

## Stack (exact versions; pin exactly, never `^` or `~`)

| Area | Version |
|---|---|
| Node | 24 (`.nvmrc`, `engines`, checked by `make`) |
| Next.js | 16.3.8, App Router, TypeScript strict |
| React / React DOM | 19.2.8 |
| TypeScript | 5.9.3 (typescript-eslint supports only versions below 6.1) |
| Supabase CLI | `supabase@2.119.0` as a **devDependency** |
| supabase-js | 2.117.2 |
| zod | 4.6.5 |
| Anthropic SDK | `@anthropic-ai/sdk` 0.131.x (exact patch pinned at install) |
| Model | `claude-haiku-5-5` |
| Stripe SDK | `stripe` 22.6.2: signature verification, plus test-mode Checkout, the billing portal and ending demo upgrades (`lib/server/billing/stripe.ts` refuses a live key) |
| UI | Tailwind CSS 4, shadcn/ui (Radix), lucide-react, TanStack Query 5 |
| Tests / tooling | Vitest 5, tsx, pg (seed and integration tests only), ESLint CLI with eslint-config-next |

- **Use npm only and commit `package-lock.json`.**
- The Supabase CLI, Next SWC, Tailwind oxide, lightningcss and esbuild ship as per-platform optional packages. We develop on x64 Linux/WSL, but the app must also install on darwin-arm64 (Apple Silicon Macs). **After any dependency change, run `npm run check:lockfile`.** It fails if the darwin-arm64 entries are missing. If it fails, regenerate the lockfile from scratch (`rm -rf node_modules package-lock.json && npm install`).
- Call the pinned CLI as `npx --no -- supabase …` or `node_modules/.bin/supabase …`, never a bare global `supabase`. That way a different version can never be fetched. Keep the `--`: without it npx swallows npm's own flags (`npx --no supabase --version` prints npm's version).
- Don't add a dependency unless it removes real work. Record why in DECISIONS.md.

## Commands

Commands appear as their milestones land. If a script is missing, its milestone hasn't happened yet.

| Command | What it does |
|---|---|
| `make setup` / `make dev` / `make reset` | Contract targets; `reset` wipes the DB and reseeds |
| `npm run dev` | Next dev server with hot reload (development only) |
| `npm run build` / `npm start` | Production build and server (`make dev` uses these) |
| `npm run typecheck` / `npm run lint` / `npm test` | `tsc --noEmit`, ESLint, Vitest unit tests |
| `npm run test:integration` | Vitest against local Supabase (needs `supabase start`) |
| `npm run test:e2e` | API contract tests against a running app |
| `npm run test:ui` | Playwright smoke at 390 px against a running app (once per machine: `npx playwright install chromium`) |
| `npm run test:security` | Cross-company attack script, bundle/HTML secret scan, hostile briefs |
| `npm run eval` | Runs queries.json and eval/*.json through the search pipeline and prints precision, recall and first-page precision |
| `npm run bench` | Paging and new-search latency (p50/p95) against a running app; `-- --fresh=3` instead starts `make dev` 3 times and times the first search after each start |
| `npm run gen:data` | Regenerates the synthetic dataset (data/*.json, public/avatars, public/logos) from `scripts/gen-dataset.ts`; run `gen:vocab` after it |
| `npm run gen:vocab` | Regenerates `lib/shared/vocabulary.generated.ts` from data/ |
| `npm run seed` | Idempotent seed: candidates, companies, auth users, recruiters |
| `npm run replay:stripe` | Replays data/stripe-events.json against the running app and prints /api/plan after each event |
| `npm run check:lockfile` | Asserts the darwin-arm64 optional packages are in the lockfile |

## Folder structure and layer rules

```
app/
  api/**/route.ts        thin route handlers: parse → call lib/server → respond via lib/server/http.ts
  login/                 sign-in page
  (app)/**               signed-in UI pages (client components that call /api/*)
components/              UI components (ui/ = shadcn primitives)
lib/
  server/**              ALL server logic: auth, Supabase clients, search pipeline, LLM call, billing, http helpers.
                         Every file starts with `import 'server-only'`.
  shared/**              client-safe code: zod schemas (Filters), generated vocabulary, lexicon, chip labels,
                         sanitizeText. Never reads env or secrets.
  client/**              browser-only: Supabase auth client, typed API client, hooks
supabase/
  config.toml            local stack config (trimmed services, auth hardening)
  migrations/*.sql       schema, RLS, grants, SQL functions; the only way the schema changes
scripts/                 setup/env/seed/eval/bench/replay/security/lockfile scripts (Node/TS, cross-platform)
tests/
  unit/                  pure logic, no DB
  integration/           against local Supabase (RLS, privileges, SQL functions, quota, billing)
  e2e/                   against a running app (API contract, burst, paging)
eval/                    gold filters and hand-written eval briefs (extra.json, hostile.json)
data/                    candidates.json, queries.json, stripe-events.json (synthetic, from npm run gen:data; committed; setup loads them)
public/                  generated avatar and logo SVGs, served by the app
```

- The UI never imports `lib/server`. Route handlers contain no SQL and no business logic.
- Data concerns live in `supabase/migrations` and `scripts/seed.ts`. Server logic lives in `lib/server`. The UI lives in `app/(app)` and `components`.

## Coding conventions

- **TypeScript:** `strict` plus `noUncheckedIndexedAccess`. No `any`; use `unknown` and narrow it. Use named exports. Prefer small pure functions. Comment only *why*, never *what*.
- **Validation at every boundary:** zod for request bodies, query params, LLM output and env. Run `sanitizeText` on every incoming string before validating or storing it. It applies `toWellFormed()`, strips control characters except `\n` and `\t`, and normalises to NFC. Apply it recursively to `filters` objects too.
- **Errors:** always `{ "error": { "code": string, "message": string } }`, produced only by `lib/server/http.ts` helpers. That module maps Postgres errors in one place:
  - `22P02` → 404
  - `23503` → 404
  - `42501` → 404
  - `23514` → 400
  - `P0402` → 402
  - `P0429` → 429 (with `Retry-After`)

  An unhandled 500 always means a bug.
- **Env:** read lazily, *inside* handlers and functions, via `lib/server/env.ts`. Never read it at module top level. `next build` must succeed with no model key, no webhook secret and no Stripe key set.
- **Next.js 16 specifics:**
  - Route `params` is a Promise (`const { id } = await params`).
  - Lint with the ESLint CLI (`next lint` no longer exists).
  - No `proxy.ts`/middleware: auth happens in route handlers.
  - Avatars and logos are SVG, so use plain `<img>` (`next/image` rejects SVG).
  - The webhook route sets `export const runtime = 'nodejs'`.
- **Formatting:** follow the existing style in the file you touch. Keep diffs minimal and focused on the task.

## Database rules

- **Schema changes only through new files in `supabase/migrations/`. Never edit a migration that has been applied or committed.**
- **Privileges: revoke first, then grant.** Supabase grants new tables *and functions* to `anon` and `authenticated` by name, so revoking from `PUBLIC` is not enough.
  - The baseline migration revokes default privileges for `anon` and `authenticated`.
  - Every later migration grants exactly what each new table or function needs, in the same file.
  - Use column-level grants where possible (e.g. `update (name)` on `shortlists`).
- **Every table has RLS enabled.** Company-owned rows use `company_id = (select private.current_company_id())` in both `using` and `with check`.
- **Candidates and their child tables:** readable by `authenticated` only, never writable through the API.
- **SECURITY DEFINER** is used only when a write must bypass RLS (e.g. quota, search storage, billing). Such a function must:
  - `set search_path = ''` and fully qualify every name;
  - derive the company from `auth.uid()`, never from a parameter;
  - grant EXECUTE to exactly one role (`authenticated` or `service_role`).

  Read-only functions are `SECURITY INVOKER` and rely on RLS.
- **The function EXECUTE allowlist is fixed and tested:**
  - `authenticated`: `reserve_search`, `complete_search`, `release_search`, `get_search_page`, `get_plan`, `count_relaxations`. Because `count_relaxations` is INVOKER, `authenticated` also executes `private.match_candidates` and the pure helpers it calls (`private` is not an RPC schema).
  - `service_role`: `apply_stripe_event`.
  - `anon`: nothing.

  If you change a grant, update `tests/integration/privileges.test.ts` in the same commit.
- **Static SQL only.** Values arrive as parameters or as a `jsonb` argument. Never concatenate or `format()` user or LLM text into SQL. There is no dynamic SQL anywhere.
- **DB constraints repeat API validation** (name length, brief length, filters is an object of 16 KB or less), because recruiters can hit PostgREST directly.

## Security rules

- **No secret in any `NEXT_PUBLIC_*` variable, client component or `lib/shared`/`lib/client` file.**
  - Only the publishable (anon) key and public URLs may reach the browser.
  - The client env module lists only `NEXT_PUBLIC_*` names, so even secret *names* never ship.
- **API routes act as the signed-in recruiter.** Each request builds a supabase-js client with the publishable key plus `Authorization: Bearer <user token>`, so PostgREST applies RLS.
- **The Supabase secret key is used only by** the seed script, test helpers and the Stripe webhook handler. All of these live in `lib/server`/`scripts`/`tests`, behind `import 'server-only'` where applicable.
- **Stripe API calls never change the plan.** Checkout and the billing portal only open Stripe's hosted pages, and ending a demo upgrade asks Stripe to cancel it. The plan still changes only when a signed webhook arrives. The Stripe key must be test-mode (`sk_test_`/`rk_test_`).
- **Another company's (or an unknown) id returns 404 after an explicit visibility lookup.** Never let a 0-row update or delete come back as 200. Always check the affected row count.
- **The brief is untrusted.** It goes to the model JSON-encoded inside `<brief>` tags, with `</brief>` neutralised. The model's output is schema-constrained and enum-only, then re-validated with zod. It never becomes SQL.
- **No `dangerouslySetInnerHTML`.**
- **Never log tokens, keys, `Authorization` headers or webhook signatures.**
- **Browser auth is same-origin.** A Next rewrite maps `/supabase/*` to the local Supabase API, so sign-in also works from a phone on the LAN.

## Search rules

- **The LLM turns the brief into filters; Postgres finds and ranks the people.** Never send candidates to the model.
- **Allowed values come only from `lib/shared/vocabulary.generated.ts`** (generated from data/ by `npm run gen:vocab`). The model's output schema is built from it. Never hand-edit the generated file.
- **Brief interpretation policy (decided by Om; do not change without his approval):**
  1. **A constraint the data can't support → 0 results, and say why.**
     - This covers an attribute the data lacks: language, remote, salary, visa, industry, tenure, age, gender, ethnicity.
     - It also covers a value outside the vocabulary: e.g. London, Elixir, Google, "FAANG", principal, lead, director, data analyst, QA, SRE, engineering manager.
     - It goes into `unsupported[]` with a reason, and the UI shows it as a removable warning chip.
     - Offer a one-tap suggestion only when there is a true nearest value (e.g. principal → Staff).
  2. **Subjective or fluffy wording is ignored, never zeroing the search.** Examples: great, rockstar, strong, top, talented, amazing, excellent, best, brilliant, 10x, passionate, ninja. These words go into `ignored[]`, which the UI shows as a quiet note.
  3. **Vague but clearly mappable words → the closest real filter, using only the fixed mapping table in PLAN.md § Search.** Each row is justified with data in DECISIONS.md. Example: "experienced" → 6+ years, which is exactly senior ∪ staff, because seniority is a pure function of years in this data. A word missing from the table is either unsupported (rule 1) or puffery (rule 2). Never guess.
  4. **Constraints true for everyone add no filter** ("in the US", "with a degree", "currently employed").
  5. **Never invent a filter value outside the data's vocabulary.** The grounding check moves proper-noun values (cities, states, employers, schools, skills) that don't appear in the brief into `unsupported[]`.
  6. **If no supported constraint is left, return 0 results** ("add a role, skill, location…"). This is enforced in TypeScript *and* in SQL, so nothing ever returns everyone.
- "senior" means senior only, not staff. "Worked at X" means any job; "currently at X" means the current job; "ex-X" means a past job at X and not currently there. A skill named as experience ("enterprise sales experience") is the skill.
- **`data/queries.json` is held-out test data.** Never copy its briefs into the prompt or into few-shot examples.
- **Any change to the prompt, LLM schema, mapping table, lexicon or `match_candidates`** requires running `npm run eval`. Paste the summary line into the commit message.

## Testing rules

- **Before saying any task is done, run `npm run typecheck && npm run lint && npm test`.** If the DB or SQL was touched, also run `npm run test:integration`. If routes changed, run `npm run test:e2e`.
- Report failures verbatim. Never claim a check passed if it wasn't run.
- Bug fixes come with a test that fails before the fix.
- Integration tests reset only the rows they touch, using `tests/integration/helpers/db.ts`. They never call `make reset`.
- Tests that need the real model are skipped (and say so) when `ANTHROPIC_API_KEY` is unset.

## UI rules

- **Design:** mobile-first (design at 390 px, then scale up), beautiful, intuitive and minimal. Nothing on screen without a reason.
- **States:** every data view has loading, empty and error states. The plan status is always visible, and Upgrade explains how upgrading works (via Stripe; the plan flips automatically when the webhook confirms).
- **Free plan:** any action that starts a new search (new brief, chip edit, saved-search re-run) says it will use the free search, or opens Upgrade when none are left. Paging is always free.
- **Accessibility:** use semantic HTML, keep everything keyboard-reachable, label every icon button, and keep text contrast at AA.

## Workflow rules

- **Work milestone by milestone, in PLAN.md order.** Each milestone ends when its acceptance check passes.
- **Commit after each milestone** on `main`, using Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). Commit smaller steps whenever they are green.
- **Add every non-obvious decision to `DECISIONS.md`, at the end of its area's section, in this format:**
  ```
  ### YYYY-MM-DD: <decision>
  - Why: <reasoning, with data or measurements if any>
  - Alternatives: <what else was considered and why not>
  ```
- **`README.md` stays at one page or less.**
- **Never push, share or publish anything** (repo, artifacts) unless Om asks.
