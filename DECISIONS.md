# DECISIONS.md

Every non-obvious decision, grouped by area. Each entry says what was decided, why (with the measurements behind it) and what else was considered. Within an area, related entries sit together, and each date is when that decision was made. A later entry that changes an earlier one says so, and the earlier one ends with an "Outcome" line.

- [Setup and toolchain](#setup-and-toolchain): how `make setup` and `make dev` behave on a clean Mac, and the pinned tools behind them.
- [Data, schema and seed](#data-schema-and-seed): what the data guarantees, how it is loaded, and the constraints that repeat API validation.
- [Access control: privileges, RLS and auth](#access-control-privileges-rls-and-auth): revoke first, grant exactly what each role needs, and RLS on every table.
- [Search: filters and SQL](#search-filters-and-sql): the canonical `Filters` and the static SQL that finds and ranks people.
- [Search: the model call, prompt and grounding](#search-the-model-call-prompt-and-grounding): how a brief becomes filters without the model inventing any.
- [Free-plan quota](#free-plan-quota): one search per company, held under concurrency; paging never counts.
- [API](#api): thin routes, one error module, and 404 for anything another company owns.
- [Billing: the Stripe webhook](#billing-the-stripe-webhook): verified, idempotent and order-safe; the plan follows the subscription's status.
- [UI](#ui): mobile-first behaviour, the free-plan flow and what the walkthroughs changed.
- [Security suite and secrets](#security-suite-and-secrets): what `npm run test:security` proves, and how keys stay off the browser and the terminal.
- [Speed](#speed): paging under 100 ms, new searches under 2.5 s at p95, and a warm first search.
- [Testing and eval](#testing-and-eval): how the suites isolate their data, and what the search eval measures.

## Setup and toolchain

How `make setup` and `make dev` behave on a clean Mac, and the pinned tools behind them.

### 2026-10-08: Supabase CLI 2.119.0 behaviour, measured (PLAN.md § 3.3 CLI check)
- Why: `make setup`, `make dev` and `write-env` rely on these behaviours, so they were measured on this machine rather than assumed.
  - **Distribution:** `supabase@2.119.0` ships the binary as per-platform `optionalDependencies` (`@supabase/cli-darwin-arm64@2.119.0` etc.). There is no postinstall download, so the lockfile must list the darwin-arm64 package (`npm run check:lockfile`).
  - **`npx --no supabase --version` prints npm's version (11.19.0), not the CLI's.** npm parses its own flags anywhere on the line. `npx --no -- supabase --version` and `node_modules/.bin/supabase --version` print `2.119.0`. Subcommand flags such as `--local` do pass through, but every call now uses `npx --no -- supabase` so no npm flag can ever be swallowed.
  - **`status -o json` keys:** `API_URL`, `DB_URL`, `REST_URL`, `GRAPHQL_URL`, `PUBLISHABLE_KEY` (`sb_publishable_…`), `SECRET_KEY` (`sb_secret_…`), `ANON_KEY`, `SERVICE_ROLE_KEY` (JWTs), `JWT_SECRET`. The JSON goes to stdout; the "new version available" notice and the "Stopped services" line go to stderr. `start` prints the same JSON on one line (plus `"message":""`). `GRAPHQL_URL` is listed even though `graphql_public` is no longer exposed.
  - **`start` when already running:** exit 0, changes nothing, prints the status JSON again.
  - **`start` applies migrations only on a fresh DB volume.** With an existing volume (after `stop`, or while running), a newly added migration is *not* applied by `start`. `migration up --local` applies it (exit 0, `{"applied":[…]}`). With nothing to apply, or no `supabase/migrations` directory at all, it also exits 0. So `make setup` runs `start` and then `migration up --local`, and is re-runnable.
  - **`db reset --local`** recreates the DB, re-applies every migration (confirmed in M1) and exits 0, with no prompt.
  - **Containers with our `config.toml`:** only `db`, `kong`, `auth` and `rest` run (studio, pg_meta, storage, imgproxy, realtime, mailpit/inbucket, edge runtime, analytics, vector and pooler are all stopped). A cold start with image pulls took 89 s; with cached images, `make setup` took 83 s end to end, most of it `npm ci`.
  - **Auth env, read from the auth container:** `GOTRUE_DISABLE_SIGNUP=true`, `GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false`, `GOTRUE_JWT_EXP=86400`, `GOTRUE_EXTERNAL_EMAIL_ENABLED=true` (the email provider, needed for password sign-in, so `[auth.email] enable_signup` stays true and sign-up is closed by `[auth] enable_signup = false`). `token_refresh` and `token_verifications` show up as `GOTRUE_RATE_LIMIT_TOKEN_REFRESH`/`_VERIFY`/`_OTP` = 10000. **`sign_in_sign_ups` has no visible env var**, so M2 must check that 50 back-to-back sign-ins all succeed.
- Alternatives: trusting the CLI docs. Rejected, because `start`'s migration behaviour and the npx flag trap both differ from what the plan assumed.

### 2026-10-08: preflight and `make dev` details
- Why:
  - `check-env.mjs` tests ports by **connecting**, not binding. On macOS, binding 127.0.0.1 can succeed while another process holds 0.0.0.0. A port held by *our own* Supabase containers (`supabase_*_rosterly`) counts as free, so `make setup` and `make dev` can be re-run. Another Supabase project on 54321/54322 gets a message that names it.
  - `make dev` rebuilds only when `app/`, `components/`, `lib/`, `public/`, the Next/PostCSS/TS configs, `package-lock.json` or `.env.local` is newer than `.next/BUILD_ID`. So `write-env` (M2) must not rewrite `.env.local` when nothing changed.
  - `NEXT_TELEMETRY_DISABLED=1` is exported by the Makefile: no telemetry call or banner on a fresh machine.
  - npm 11's `allowScripts` skips `unrs-resolver`'s postinstall. That's harmless: it only repairs a missing native binding, and the binding comes from optional dependencies listed in the lockfile.
- Alternatives: always rebuilding in `make dev` (adds ~15 s to every start), or `next dev` (first-hit compiles would break the speed checks; PLAN.md A13).

### 2026-10-09: the Docker preflight retries for about 10 s
- Why: `make dev` once failed with "Docker is not running" right after `make setup`, although Docker was fine. Docker Desktop can miss a `docker info` call while it is busy. The check now retries every 2 s until 10 s have passed since the first attempt. It prints one "checking again" line, then either passes or fails with the old message. A missing Docker CLI still fails immediately. Checked with a fake `docker` on the PATH: two failures then success passes after about 5 s; failing every time ends after 10.1 s with the message.
- Alternatives: a longer single timeout (doesn't help when `docker info` *fails* rather than hangs); dropping the check (`supabase start` would then fail with a much less helpful error).

### 2026-10-08: write-env manages four keys and rewrites only on change
- Why: `.env.local` gets `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the `sb_publishable_` key, falling back to `ANON_KEY`), `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (`sb_secret_`, falling back to `SERVICE_ROLE_KEY`) and `DATABASE_URL`. Other lines are kept verbatim below the managed block. The file is written with mode 0600 and **only when its content changes**, so `make dev`'s build-if-stale check doesn't rebuild on every start (checked: a second run leaves the mtime unchanged). If someone has put `ANTHROPIC_API_KEY` or `STRIPE_WEBHOOK_SECRET` in it, write-env warns but doesn't delete their line. The script itself never writes either one.
- Alternatives: regenerating the whole file (would wipe a developer's own lines and force a rebuild every time); `dotenv` parsing (a dependency for something a one-line regex handles).

### 2026-10-09: the model key and webhook secret may live in `.env.local` for local development
- Why: Om keeps both in the git-ignored `.env.local`, so Claude Code never has `ANTHROPIC_API_KEY` in its own environment. Anyone else can export them in their shell. Next reads both, and an exported value wins. So:
  - `check-env.mjs dev` (the `make dev` preflight) warns only when a key is set in neither place. It reads `.env.local` for *names with a non-empty value* and never prints a value. Checked with an empty value, a quoted value, a shell-only value and no file.
  - `write-env.mjs` no longer warns "prefer exporting it", and still never writes either key.
  - CLAUDE.md § Output contract and PLAN.md § 3.3 say this.
- Alternatives: keeping the warning (it would contradict the setup Om chose on purpose); having write-env manage the keys (they must never be written by a script).

### 2026-10-08: lockfile check derives the darwin-arm64 list from the lockfile itself
- Why: native packages arrive through several tools (Next SWC, sharp, Tailwind oxide, lightningcss, rolldown via Vite 8, unrs-resolver via ESLint, the Supabase CLI), and the list grows with every dependency. `check-lockfile.mjs` names the two critical ones explicitly (`@supabase/cli-darwin-arm64@2.119.0`, `@next/swc-darwin-arm64@16.3.8`), then requires a darwin-arm64 twin, at the same version and with `resolved` and `integrity`, for **every** `*-linux-x64[-gnu]` package in the lockfile. Tailwind went in at M0 so its natives are covered from the first commit.
- Alternatives: a hand-kept list (silently goes stale when a dependency adds a native package).

### 2026-10-08: ESLint 9.39.5, not ESLint 10
- Why: `eslint-config-next@16.3.8` depends on `eslint-plugin-react`, `eslint-plugin-import` and `eslint-plugin-jsx-a11y`, whose peer ranges stop at ESLint 9. The `create-next-app@16.3.8` template itself pins `eslint: ^9`. npm prints a deprecation notice for 9.39.5 on install. It is cosmetic and doesn't affect the build.
- Alternatives: ESLint 10 (unsupported peers, so lint could break in ways we'd debug on someone else's Mac).

### 2026-10-08: Vite pinned as a devDependency (8.3.4)
- Why: Vitest 5 declares `vite` as a peer dependency, not a dependency. Pinning it keeps "exact versions only" true, rather than taking whatever npm auto-installs for the peer.
- Alternatives: let npm resolve the peer (the version could drift between lockfile regenerations).

### 2026-10-08: `next-env.d.ts` is git-ignored; `typecheck` runs `next typegen` first
- Why: Next 16 rewrites `next-env.d.ts` on every build (it imports generated route types), so committing it causes churn. `next typegen && tsc --noEmit` generates the types without a build, so a clean clone typechecks straight away.
- Alternatives: commit the file (constant diffs), or typecheck only after `next build` (slow, and the build order would matter).

### 2026-10-08: dependencies added in M6
- Why: `@anthropic-ai/sdk` 0.131.0, from the stack table (the only 0.131.x release, published 2026-09-30). `server-only` 0.0.1 is the marker CLAUDE.md requires in every `lib/server` file: importing a server module from a client component then fails the build. Neither has native parts, and `check:lockfile` passes.
- Alternatives: relying on Next's internal alias for `server-only` (works in the bundler, but tests and scripts couldn't resolve it).

### 2026-10-09: clean-clone rehearsal (M13)
- Why: a new user runs `make setup` and `make dev` in a fresh clone on a clean machine, so that run was rehearsed as closely as this machine allows.
  - **A fresh database:** the clone uses the same `project_id`, so it would have reattached Om's DB volume. Om's stack was stopped, its volume copied to a backup (content and owner/mode/size of all 1,624 paths compared) and removed, so the clone's `supabase start` met an empty volume. Afterwards the clone's stack went with `stop --no-backup`, the volume was restored from the backup (compared again: identical), and Om's stack started on it ("Starting database from backup").
  - **Like a new user's shell:** `git clone` of the repo into `/var/tmp`, an empty npm cache (`npm_config_cache`), the model key and webhook secret passed to the `make` process only, and `CLAUDECODE`/`AI_AGENT` removed so the Supabase CLI printed its human format. Docker images were already cached, so pulls aren't in these numbers (`supabase start` with pulls took 89 s in M0).

  | Step | Time |
  |---|---|
  | `git clone` | 1.4 s |
  | **`make setup`, total** | **125 s** |
  | preflight | 2.5 s |
  | `npm ci` (509 packages, empty cache) | 44 s |
  | `supabase start` (empty volume: init, 8 migrations, health checks) | 29.8 s |
  | `migration up --local` | 1.5 s |
  | write-env and seed (5,000 candidates, 9,620 jobs, 5,000 degrees, 2 companies, 2 recruiters) | 1.5 s + 2.0 s |
  | `next build` | 40 s |
  | **`make dev` until Next's "Ready"** | **7.5 s** (its background warm-up finished at 3.5 s) |
  | **First search after `make dev`** (asterwell, sent as soon as the server answered) | **1,970 ms**, 21 results |

  - **Checks, all passing:** asterwell starts free with 1 left → search 200 (21) → paging returns every id once (p95 41 ms) → plan free with 0 left → a second search gets 402 in 22 ms → `npm run replay:stripe`: all 5 rows and the final state pass (asterwell free, glenfold paid) → two glenfold searches as paid take 2,004 and 1,860 ms, paging p95 22 and 17 ms, and the plan stays paid with `searches_remaining: null`.
  - **Suites against the clone's `make dev`:** `npm run test:e2e` 117/117 and `npm run test:security` 229/229. `npm run test:ui` couldn't start Chromium on this WSL machine (`libnspr4.so` is missing, and `npx playwright install-deps chromium` needs sudo), so the UI part of the walkthrough stays manual.
  - **No secrets on the terminal:** every captured line (setup, dev, replay, the three suites) was checked for the model key, the webhook secret, the clone's secret key and DB password, `sk-ant-`, `sb_secret_` followed by a key, JWTs and `whsec_`. None were found.
  - npm 11 skips `esbuild`'s postinstall as well as `unrs-resolver`'s (allowScripts). That's harmless: tsx ran the seed and every script on the binary from the lockfile's optional dependency.
  - The model's caches were warm (the eval had run 20 minutes earlier). M12 measured the first search after a cold start with the warm-up at 1.9–2.2 s.
- Alternatives: a different `project_id` in the clone (no volume juggling, but then the clone isn't what a new user runs); cloning the local repo (it would hide anything not pushed).

### 2026-10-14: Hosted on Vercel, with Supabase Cloud as the database
- Why: the app needs Supabase's auth, PostgREST and RLS, and Vercel runs no Docker, so the database moves to a Supabase Cloud project (`rosterly`, us-east-1, Postgres 17) and the app to a Vercel project of the same name. `vercel.json` pins functions to `iad1`, next to the database. No app code changed: the server reads the same `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` (set in Vercel for production), and the `/supabase/*` rewrite points at the hosted URL because `next.config.ts` reads `SUPABASE_URL` at build time.
  - **The hosted project doesn't read `config.toml`,** so its settings are set separately to match it: sign-up off (a stranger with the public publishable key could otherwise mint an `authenticated` session and read every candidate), anonymous sign-ins off, and only `public` exposed (no `graphql_public`). `supabase config push` was not used, because it would also push the raised local rate limits and the `localhost` site URL.
  - **Migrations** go through `supabase db push --linked`. **The seed** is the same `npm run seed`, with the production values exported over `.env.local` (the shell wins). The values live outside the repo, in `~/.config/rosterly/production.env` (mode 600). The seed connects through the session pooler with `sslmode=verify-full` against Supabase's root CA (`NODE_EXTRA_CA_CERTS`), because the pooler's certificate chain isn't publicly trusted.
  - `supabase projects api-keys` masks the new `sb_secret_` key with `·` unless `--reveal` is passed. The masked value has the right length, and the API answers it with 401 `Invalid API key`.
  - **The production webhook secret must not be `whsec_rosterly_sample`.** Signatures of any age are accepted, so with the public sample secret anyone could replay "paid" and run unlimited searches on the model key. The plan flips through `npm run replay:stripe -- --resign --base-url <url>` with the production secret, or a real Stripe endpoint.
  - `.vercelignore` repeats `.gitignore`, because `vercel deploy` uploads the working tree, so what is left out mustn't depend on whether the CLI reads `.gitignore`. `.logs/` holds the Supabase CLI's output, keys included.
- Alternatives: one server running self-hosted Supabase in Docker (about ten containers plus TLS, backups and upgrades to maintain); plain Postgres (Neon) would mean rewriting auth, RLS on `auth.uid()` and every PostgREST call; deploying from GitHub (auto-deploys on push; possible later with `vercel git connect`).

## Data, schema and seed

What the data guarantees, how it is loaded, and the constraints that repeat API validation.

### 2026-10-08: vocabulary generation and the lexicon
- Why:
  - `gen-vocabulary.ts` sorts case-insensitively, then by codepoint, with no locale tables, so the output is byte-identical on every machine. Seniorities are ordered by years. It **asserts** the facts the plan relies on: seniority is a pure function of years with disjoint ranges (junior 0–2, mid 3–5, senior 6–9, staff 10–15), each city has one state, each employer has one type and logo, `experiences[0]` is the only current job and equals `current_company`, and no skill repeats within a candidate.
  - **Lexicon alias syntax:** a lowercase alias matches case-insensitively and an alias with a capital matches that exact case (`Go`, `R`, `LA`, state codes, so "Chicago" and "go remote" never mean Go). Spaces and hyphens match any run of either or none (`front end` = front-end = frontend), with an optional plural "s", and whole words are judged by Unicode letters and digits.
  - **A match inside a longer match is not a mention:** "React" in "React Native", "New York" in "New York University", "Washington" in "University of Washington". Role phrases are in the lexicon only to claim their words: "machine learning engineers" is the role, not the Machine Learning skill. `NON_VALUES` claim phrases outside the data ("Washington DC"), so they can't ground the state WA.
  - **Aliases lean generous** (e.g. `node`, `pipeline`, `ml`). Grounding exists to catch *invented* values. A missing alias would wrongly move a real value to `unsupported` and zero a correct search, which costs more than letting a borderline mention through.
- Alternatives: a single big alternation regex (equal-span matches such as "Illinois" = state and school can't both be reported); case-insensitive matching everywhere (Go/R/state codes would match ordinary words).

### 2026-10-08: schema details beyond PLAN.md § 3.1
- Why:
  - **One current job per candidate is enforced:** `unique (candidate_id) where end_year is null` replaces the plain partial index and also serves "currently at…".
  - **`search_results` has `unique (search_id, candidate_id)`**, so "every result exactly once across pages" is a database guarantee, not just a property of the ranking query. It costs a second index on the ≤5k-row insert; M5 measures it. It also has a composite FK `(search_id, company_id) → searches (id, company_id)`, the same pattern as `shortlist_people`, so results can't be filed under another company.
  - **Only `seniority` and `company_type` have CHECK constraints.** They are fixed concepts the mapping table depends on, and the vocabulary generator fails if the data stops matching them. Roles, skills, cities and the rest are data, not schema.
  - **`subscriptions.status` is free text (≤64 chars):** an unknown future Stripe status is stored and read as "not paid" instead of failing the webhook.
  - **Text rules repeat `sanitizeText`:** briefs reject C0/C1 control characters except `\n` and `\t` (so `\r` is rejected too); shortlist names are single-line, ≤80 characters and not blank. Postgres' regex honours `\uXXXX` inside bracket classes; the tests check `\u0007`, `\r`, `\u0085` and `\u007f`.
  - **Filters size is `octet_length(filters::text) ≤ 16384`**, using Postgres' canonical rendering. It is slightly larger than compact `JSON.stringify` output (`", "` and `": "`), so near the limit the DB can reject what the API accepted. Both paths end in 400 (`23514` → 400), so the outcome is the same.
- Alternatives: enum CHECKs for every vocabulary column (schema churn whenever the data changes), or `pg_column_size` for the size limit (it depends on TOAST compression, so it isn't predictable).

### 2026-10-08: seed loads candidates as one jsonb parameter, upserts, and never resets usage
- Why:
  - `scripts/seed.ts` sends `data/candidates.json` to Postgres once, as a single `jsonb` parameter in a temp table (`on commit drop`). Three static `insert … select` statements then expand it into candidates, experiences (array index = `position`, so `experiences[0]` stays the current job) and education. There is no string building and only one round trip for 6.5 MB. A fresh load takes 2.0–2.4 s; a re-run takes about 1 s.
  - **Re-runs write nothing:** every upsert has `where (t.*) is distinct from (excluded.*)`, and extra child rows (a list that got shorter in the data) are deleted, so the DB converges on the file. A mutation check (seeding `title` into `description`) failed the lossless test, and the next seed repaired the rows.
  - **`company_usage` rows are inserted with `on conflict do nothing`,** so re-seeding never hands out a new free search. `make reset` is the only way back to a fresh counter.
  - **Auth users:** list first, then `auth.admin.createUser({ email_confirm: true })` for any that are missing. An existing user is left alone (no password reset), so re-running `make setup` keeps live sessions valid.
  - **The demo accounts live in `lib/shared/demo-accounts.ts`:** the seed, the tests and the login page's one-tap fill buttons (M9) share one list. The password is public by contract, so it's not a secret in the client bundle.
  - `@supabase/supabase-js@2.117.2` (from the stack table) is added now as a runtime dependency, because the seed needs the auth admin API. It has no native parts, and `check:lockfile` still passes.
- Alternatives: `supabase/seed.sql` (it can't create GoTrue users with a proper password hash, and the CLI runs it only on `db reset`); 5,000 row-by-row inserts (slower, and more SQL); inserting into `auth.users` directly (depends on GoTrue's internal schema).

### 2026-10-13: Rosterly's own synthetic dataset, generated by `scripts/gen-dataset.ts`
- Why: Rosterly is a personal project, and the original candidates, test briefs, webhook sample and images belonged to someone else. A seeded generator makes all of it ours and reproducible: `npm run gen:data` writes the same bytes on every run, then `npm run gen:vocab` re-checks the invariants.
  - **Kept generic on purpose:** the 13 roles, the seniority bands (junior 0–2, mid 3–5, senior 6–9, staff 10–15, which the "experienced → 6+ years" row relies on), the 10 US cities, the 79 skill names, 13 real universities, 5 degrees and 14 fields. The prompt, lexicon and mapping table are written against these values, so they stay valid.
  - **New:** names, 30 invented employers (13 enterprise, 17 startup), careers of 1–5 jobs with promotions and sometimes an earlier job in a neighbouring role, headlines, job descriptions (they name the skills used, for ranking signal 2) and every distribution.
  - **`data/queries.json`:** 10 new briefs. Their expected ids come from plain TypeScript predicates in the generator, never from `match_candidates`, so the eval and `tests/integration/match-candidates.test.ts` keep an independent answer key. No brief appears in the prompt; one was switched from iOS to Android because the prompt's rule examples mention "iOS engineers".
  - **`data/stripe-events.json`:** the same five-event scenario (subscribe, repeat, newer first, older late, cancel) with new ids and timestamps, signed with the public sample secret `whsec_rosterly_sample`.
  - **Images:** abstract avatars and letter-mark logos as SVGs in `public/`, so nothing loads from a third-party host and no avatar pretends to be a real face.
  - **Demo companies:** Asterwell and Glenfold (`recruiter@asterwell.test`, `recruiter@glenfold.test`, password `rosterly-demo`). Their initials match the A/G shorthands in the security script and tests.
  - The prompt's counts (employers, cities, schools, skills, roles) now come from the vocabulary instead of literals; `PROMPT_VERSION` is 5.
- Alternatives: renaming the original records in place (the same people, careers and test briefs under new labels, still recognisably someone else's data); copying the original SVGs into `public/` (the same look, someone else's artwork).

## Access control: privileges, RLS and auth

Revoke first, grant exactly what each role needs, and RLS on every table.

### 2026-10-08: `auto_expose_new_tables = false`, but the revoke-then-grant baseline is still required
- Why: with the flag off, a table created by `postgres` in `public` still grants **TRUNCATE, REFERENCES, TRIGGER and MAINTAIN** to `anon`, `authenticated` and `service_role` (default ACL `Dxtm`), and a new function is still **EXECUTE-able by PUBLIC** (Postgres' built-in default). Measured with a probe table and function that were then dropped. So the flag removes the dangerous select/insert/update/delete defaults, and the M1 baseline migration still revokes everything else explicitly, including `EXECUTE … FROM PUBLIC`.
- Alternatives: rely on the flag alone (leaves TRUNCATE and PUBLIC EXECUTE), or rely on the migration alone (works, but loses a second layer if a later migration forgets a revoke).

### 2026-10-08: the schema migration enables RLS and grants nothing; grants and policies arrive together in M3
- Why: CLAUDE.md wants grants in the same file as the table, but PLAN.md schedules RLS and grants as M3 (`*_rls.sql`). Splitting them safely means the M1 tables are deny-all: the revoke baseline runs first, every table has RLS enabled with no policies, and nothing is granted. So no table is ever reachable by an API role before its policies exist. M3 adds each table's grants and policies in one file.
- Note for M3: RLS policies and column defaults run as the caller, so `authenticated` needs `USAGE` on schema `private` and `EXECUTE` on `private.current_company_id()`. PostgREST still can't call it, because `private` is not an exposed schema. The privilege test must list it next to the public RPC allowlist.
- Alternatives: writing RLS and grants now (pulls M3 forward without its tests), or creating tables with no RLS until M3 (a window where a stray grant would expose rows).

### 2026-10-08: RLS and grants (M3): column-level inserts, recruiter-only candidates, nothing for service_role
- Why:
  - **Inserts are column-level too, not just `update (name)`:** `shortlists` gets `insert (name)`, `shortlist_people` `insert (shortlist_id, candidate_id)`, `saved_briefs` `insert (brief, filters)`. `company_id`, `created_by`/`added_by` and `id` therefore always come from the column defaults (`private.current_company_id()`, `auth.uid()`). A recruiter can't plant a row under another company, or under another user's name, even before RLS's `with check` runs. PostgREST's `upsert(…, { ignoreDuplicates: true })` (`on conflict do nothing`) works with these grants (tested), so M7's idempotent add needs nothing more.
  - **Candidates are readable only by a recruiter:** the policy is `(select private.current_company_id()) is not null`, not `true`. Sign-up is closed, but an auth user without a recruiter row (e.g. one created by hand in Studio) still sees no candidates. The initplan runs once per query.
  - **`service_role` has no table privileges at all.** The seed and the tests write through `pg` as `postgres`, and the webhook will go through `apply_stripe_event` (M8). `service_role` has BYPASSRLS, so a stray grant would bypass every policy; with no grants it reaches nothing.
  - **Cross-company adds have no existence oracle:** adding a person to glenfold's list as asterwell fails with `23503` (the composite FK finds no `(list, asterwell)` row). That's the same code as a list that doesn't exist, and M7 maps both to 404.
  - `config.toml` needed no M3 change: M0 had already closed sign-up and anonymous sign-ins. Tests confirm: sign-up → `signup_disabled`, anonymous sign-in → error, `/graphql/v1` → 406 `PGRST106`, and anon's OpenAPI lists only `/`.
  - **Mutation check:** loosening `shortlists_company` to `using (true)` and granting `update (searches_used)` failed 9 of the 20 RLS and privilege tests; after restoring, all passed.
- Alternatives: table-level `insert` plus `with check` (correct for company_id, but `created_by` could be spoofed, and a default that's never overridden is simpler); `using (true)` for candidates (any auth user could read them); granting `service_role` the usual Supabase defaults (unneeded, and it bypasses RLS).

### 2026-10-08: auth limits, measured with the seeded users
- Why: the M0 note left `sign_in_sign_ups` unverified because no env var for it is visible. Measured against the running stack: **60 back-to-back password sign-ins all returned 200**, a wrong password returns 400, and `POST /auth/v1/signup` returns 422 `signup_disabled`. Hosted Supabase's default for sign-ins is 30 per 5 minutes, so whichever GoTrue limit covers `/token?grant_type=password` is raised. `seed.test.ts` keeps a 50-sign-in check so a CLI upgrade can't quietly bring the default back.
- Alternatives: trusting `config.toml` alone (the setting isn't visible in the container's env, so it can't be confirmed by reading it).

## Search: filters and SQL

The canonical `Filters` and the static SQL that finds and ranks people.

### 2026-10-08: canonical `Filters` (M4)
- Why:
  - **Strict objects, vocabulary enums, the same caps as SQL:** unknown keys are rejected (400 on refine and saved-brief re-run), lists hold at most 50 values, `experience` at most 10 conditions, and the JSON at most 16 KB. These repeat `private.filter_*` and the table CHECKs, so the API, PostgREST and SQL all agree on what's valid.
  - **An empty list means no constraint,** the same as an absent one. The LLM schema (M6) uses empty arrays for "none", so both forms must behave the same everywhere.
  - **Not substantive:** `exclude` alone, `ignored` and `unsupported`. An exclusion-only brief ("anyone but recruiters") returns 0, not about 4,600 people.
  - **A filter set that matches everyone returns 0.** Rule 4 says a constraint true for everyone adds no filter. If the whole result equals all candidates, then no constraint narrowed anything, so rule 6 applies. In SQL this catches `years_min: 0`, `years_max: 99`, "all four seniorities" and the like even if postprocessing misses one. Cost: one index-only `count(*)` (< 1 ms).
  - **An experience condition needs a company type or an employer.** Without either it would match every job (`any`) or no one (`never`).
  - A `suggestion` is a discriminated union per list field, with values from that field's vocabulary. `normalizeFilters` dedupes, sorts lists in vocabulary order and drops empty lists, so equal filters serialise identically (chips, saved briefs, cache keys).
- Alternatives: loose objects that ignore unknown keys (a typo such as `role` would silently widen a search); treating exclusions as substantive (a hostile "everyone except X" would return nearly everyone).

### 2026-10-08: `match_candidates` (M4): private, validated, verified against an oracle
- Why:
  - **It lives in `private` and is granted to nobody.** `complete_search` (M5, SECURITY DEFINER) will be its only caller, so it is never an RPC and the EXECUTE allowlist is unchanged.
  - **The input is checked before anything runs:** `filter_list`/`filter_int`/`filter_bool`/`filter_experience` read each field into a typed plpgsql variable and raise `23514` (→ 400) on a wrong shape. A test asserts that zod and SQL reject the same 15 malformed inputs. One static query then uses the variables with null guards.
  - **Ranking signal 2 (requested skills in the current job):** a requested skill counts if the candidate has it **and** the current job's description names it as a whole word (case-sensitive, matched as an escaped literal). Measured: all 9,620 descriptions follow "<title> at <company>, working mostly with <A> and <B>.", and A and B are always among the candidate's skills. The "has it" requirement stops React from matching a "React Native" description (no candidate has both).
  - **Ties break on `id collate "C"`,** so the order is the same on every machine whatever the database locale (`en_US.UTF-8` here).
  - **Verification:** `tests/integration/helpers/oracle.ts` re-implements the semantics and the ranking in TypeScript over `data/candidates.json`. 23 hand-written cases cover every field, every exclusion and every `when`, and are compared as exact ordered lists. The gold filters for the 10 public briefs (`eval/gold-filters.json`) give P = R = 1. Mutation checks (`past` without "not current", `never` always true, ranking without signal 2) each fail 5–6 tests.
- Alternatives: `search_path`-qualified dynamic SQL built per request (fast plans, but "no dynamic SQL" is a hard rule); trusting zod alone (a direct `complete_search` RPC with bad JSON would throw a 500).

### 2026-10-08: `match_candidates` speed: three migrations, measured
- Why: p50 server time over 15 runs (`explain analyze` of the call, WSL2 laptop):

  | Case | v1 `search` | v2 `search_speed` | v3 `search_filter_first` |
  |---|---|---|---|
  | gold: senior React engineers in New York who worked at a startup (21 rows) | 6.9 ms | 25 ms | **3.8 ms** |
  | gold: mobile engineers who know Swift (199) | 10.6 | 5.6 | **4.6** |
  | years ≥ 1 (4,676 rows ranked) | 56 | 16 | **16** |
  | an ex-employer, no other filter (173) | 100 | 16 | 36 |
  | ex-startup and now at an enterprise, no other filter (917) | 152 | 50 | 62 |
  | staff + 4 exclusions (1,115) | 23 | 6 | 17 |

  - **v1:** one correlated `EXISTS` per candidate per condition. Its helpers had `set search_path`, and **a SQL function with a SET clause is never inlined**, so every row paid a real function call plus a settings save and restore.
  - **v2:** the helpers can be inlined (no SET; they use only built-in operators, which resolve in `pg_catalog` first, and their caller pins `search_path = ''`). Experience conditions are judged set-based, and ranking subqueries are skipped when unused. But every brief now paid for scanning all 9,620 jobs.
  - **v3 (current):** candidate-column filters run first (`base`), and experience and education checks only look at those candidates. The per-condition grouping key is `collate "C"`, because `strcoll` under `en_US.UTF-8` doubled the sort (39 → 21 ms for that step).
  - **EXPLAIN of the slowest case** (two experience conditions, nothing else; `auto_explain` with timing, so inflated): base seq scan of 5,000 rows 1.9 ms → nested loop of 2 conditions × 9,620 jobs 11 ms → hash join with base, 20 ms cumulative → sort and group into 6,753 (candidate, condition) rows, 32 ms → 917 passing candidates, 39 ms → ranking and windows, 48 ms.
  - **Why stop here:** a typical brief names a role and runs in about 4 ms. The worst case (experience-only, every job read) costs 40–60 ms, against about 1–1.5 s for the LLM call, and paging never runs this function (frozen ranks). Going further means denormalising employer arrays onto `candidates`, which isn't worth it at 5k rows.
  - **Three files, not one edited file:** CLAUDE.md forbids editing an applied migration, and v1 and v2 had already run on the local DB. Each later file uses `create or replace` with the same semantics, and the test suite passes after `make reset` on all of them.
  - **Tooling gotcha:** `supabase migration new` reads the migration body from stdin when stdin isn't a terminal, and waits forever if nothing arrives. Call it with `< /dev/null`.
- Alternatives: denormalised `employers`/`company_types` arrays plus GIN on `candidates` (faster "worked at", but changes the schema and seed, and "past"/"current" need more arrays); a TypeScript matcher over an in-memory copy (fast, but the database stops being the single source of truth, and RLS/SQL guards wouldn't apply).

### 2026-10-08: search_results write cost; the candidate foreign key is dropped
- Why: `complete_search` inserts every ranked id. Measured inside a rolled-back transaction, second call (warm), 4,676 results: **194 ms as built in M1**, 95 ms without the `candidate_id → candidates` FK, 53 ms without both FKs, and 45 ms also without `unique (search_id, candidate_id)`. The candidate FK protects nothing here: only `complete_search` writes the table, with ids taken from `candidates`, and candidates are never deleted. A new migration drops it. The `(search_id, company_id)` FK stays (it carries the cascade and keeps results under their search's company), and so does the unique index (8 ms per 4.7k rows for the "every id exactly once" guarantee). Now: **7 results 4.7 ms, 199 results 11 ms, 1,752 results 45 ms, 4,676 results 108 ms.** Paging the 4,676-result search takes 1.4–2.0 ms for pages 1, 150 and 234.
- Alternatives: ranked ids as one `text[]` on `searches` (a one-row write, but every page detoasts the whole array, and it would undo M1's schema and tests); keeping the FK (doubles the worst case for no protection).

### 2026-10-14: Suggesting a broader search when nothing matches
- Why: "No one matches all of these" left the recruiter to guess which filter to drop. Now the empty state offers the three one-filter relaxations that find the most people, with live counts ("Drop “CUDA” · 26 people"). With warnings it shows what "Search without it" would find. Tapping one is an ordinary chip edit (a refine: it counts on Free, with the cost note, or opens Upgrade). Reading the counts is free: `GET /api/search/{id}/broader`.
  - **The steps are computed in `lib/shared/chips.ts` (`relaxations`)** from the chips themselves, so a suggestion is exactly what tapping that chip's × would do. While the brief has warnings, the only step is dropping all of them, because with a warning left nothing else can find anyone. Steps with nothing left to search on are skipped.
  - **The counts come from `count_relaxations`**, which runs `match_candidates` for each variant without storing anything (31 ms for 4 variants locally). It only accepts variants that are the stored search's own filters with parts removed (`stored @> variant`), read under RLS. So it can't count a filter set the company never paid for, and another company's search is a 404. It is SECURITY INVOKER per CLAUDE.md, so `authenticated` now executes `private.match_candidates` and its five pure helpers. That opens no data, since recruiters can already read candidates and `private` isn't an RPC schema. The allowlist test lists each grant.
  - Only a search with 0 results is relaxed; any other returns `[]` without touching the matcher. A count that fails to load leaves the old advice in place.
  - Checked at 390 px in Chromium against the production build: two suggestions (the step that still finds no one is hidden), a tap runs the search (7 people), and the warning card says "Finds 26 people", with no horizontal scroll.
- Alternatives: dropping two filters (combinatorial, and harder to say in one line); computing the counts in `complete_search` for every empty search (slows every empty search, mostly for counts nobody reads); a DEFINER function (CLAUDE.md keeps DEFINER for writes, and INVOKER needs only grants on code that reads what recruiters can already read).

## Search: the model call, prompt and grounding

How a brief becomes filters without the model inventing any.

### 2026-10-08: the model call uses `messages.create` with our own JSON schema, not `zodOutputFormat`
- Why: in `@anthropic-ai/sdk` 0.131.0, `zodOutputFormat` passes the schema through `transformJSONSchema`, which moves `enum` and `const` on string schemas into the `description` ("{enum: [...]}"). The grammar would then accept any string, so "enum-only output" would hold only in the prompt. `llmJsonSchema()` instead renders `LlmFilters` with `z.toJSONSchema` (a local registry names the vocabularies as `$defs`: Role, Skill, City…) and strips only what structured outputs rejects (`$schema`, `minimum`/`maximum`, which `z.int()` always emits). A unit test fails if any description contains `enum:`/`const:`, if an object isn't strict with every property required, or if a rejected keyword appears. With `create` (not `parse`), `stop_reason` is checked before parsing, then `JSON.parse` and `LlmFilters.safeParse`: a refusal, a `max_tokens` cut-off or output that fails validation becomes a zero-result search (A15) instead of an SDK exception. Errors: connection errors and timeouts, 429 and 5xx (529 included) → `LlmUnavailableError` (503); any other API error or a missing key → `LlmConfigError` (500). The request is `claude-haiku-5-5`, `thinking: disabled`, `effort: low`, `max_tokens` 1000, client timeout 8 s with 1 retry, and no sampling parameters.
- Alternatives: `zodOutputFormat` + `messages.parse` (silently unconstrained enums; parse failures throw a generic `AnthropicError`); a hand-written JSON schema (a second copy of the vocabulary that could drift from zod).

### 2026-10-08: prompt layout, caching and the brief envelope
- Why: the system prompt is one static block (rules, the vocabulary rendered from `vocabulary.generated.ts`, the mapping table, 10 synthetic few-shots) with `cache_control` at a 1-hour TTL. Today's date is a second, uncached system block after the breakpoint. Measured: about 8.9k tokens (prompt plus schema) are written once, then 75/75 calls in an eval run read them from cache, and uncached input averages 45 tokens. The brief is sent as `<brief>` + `JSON.stringify(brief)` with `<` and `>` turned into `\u003c`/`\u003e`, so nothing in a brief can close the tag or open a new one, and the JSON still decodes to the exact brief (tested). `unsupported` and `ignored` come first in the schema, so the model sets aside what it can't map before filling the enums. A unit test fails if any `data/queries.json` brief appears in the prompt.
- Alternatives: the date in the cached block (busts the cache daily); XML-escaping the brief (the model then reads `&lt;` in skill names such as "A/B Testing").

### 2026-10-08: model text is screened, reasons are codes, suggestions come from a fixed table
- Why: `unsupported[].text` and `ignored[]` are the only free text the model writes, and the API and UI show them, so a brief could make the model copy its instructions there. Measured: for the hostile JSON-injection brief, the model put one of the prompt's own few-shot lines into `ignored`, and the screen dropped it. Rules (in `postprocess`):
  - text survives only if its words appear in the brief in order (lowercased, letters and digits only), cut to 60 characters;
  - an `unsupported` entry that fails this keeps its place with the text "Part of the brief", because dropping it would widen the result (rule 1);
  - the model returns a reason **code** (16 codes: language, work_arrangement, …, inexpressible, other), and the sentence comes from `REASONS`; any other reason string becomes "other";
  - suggestions come only from `unsupported.ts`: principal → staff (CLAUDE.md) and SRE → DevOps Engineer.
  
  Grounding entries are written by the server (a vocabulary value plus a fixed template), so they aren't screened. The eval runs `promptFragmentIn` on every hostile response: it fails on any 40-character stretch of the system prompt that the brief doesn't itself contain.
- Alternatives: capping model prose at 60 characters (a 12-entry answer could still carry ~700 characters of prompt); dropping unquoted unsupported entries (widens results); letting the model pick suggestions from the vocabulary (it could suggest anything enum-valid).

### 2026-10-08: screened model text is JSON-unescaped before the quote check
- Why: hostile brief #12 showed the model quoting `<script>…` exactly as it saw it in the envelope, as `\u003cscript\u003e…`. The words check then didn't see a quote of the brief, so the entry's text was replaced (safe, but wrong). `\uXXXX`, `\n` and `\t` in model text are now decoded and then sanitised before screening. It's still a quote check, so this lets nothing new through. The test failed before the fix.
- Alternatives: escaping `<` and `>` differently in the envelope (any escape the model can see, it can copy back).

### 2026-10-08: mapping-table rows added in M6 (approved by Om)
- Why, with data:
  - **A bare "N years (of experience)" → `years_min` N.** This is the usual recruiting reading of "5 years of experience". The exact reading changes results a lot: data engineers who know Spark give 108 for ≥ 5 years but 13 for exactly 5. "N or more" and "minimum N" are synonyms of "at least N", and "at most N" / "up to N" give `years_max` N.
  - **Role words:** each maps to the only role of its kind in the data. Account Executive is the only sales role, Product Designer the only design role, Marketing Manager the only marketing role and Recruiter the only talent role. devs, SWEs and "software engineers" mean the same as "engineers" (the 7 engineering roles).
  - **Puffery:** motivated, smart, world-class and hungry join the list (rule 2).
  - **Cities and states ground each other.** The model sometimes adds an unnamed state next to a named city. "Los Angeles" then becomes LA ∪ CA, which is 1,375 people instead of 485, so that state is dropped rather than marked unsupported. An unnamed city under a named state changes nothing and is dropped too. "Austin, TX" means the city.
- Alternatives: leaving a bare "N years" to the model (it read it as an exact value 3 times out of 3 before the rule was its own sentence); treating an extra state as a grounding failure (zeroes a correct search).

### 2026-10-08: the stated-level guard (approved by Om)
- Why: the model sometimes "resolved" the contradiction in "junior engineers with 15+ years of experience" by dropping junior and keeping only the years, which returned 322 staff engineers. Measured before the guard: 4/8 runs wrong inside the eval, and effort medium was no better (5/8). `postprocess` now finds the mapping table's level phrases as whole words (junior, entry-level, new grad, early-career, mid-level, senior, staff; a bare "mid" is left out because "mid-size" isn't a level). If one isn't negated, the answer has no seniority, and the model didn't quote the word in `unsupported` or `ignored`, it becomes an unsupported entry with a fixed reason. The result is then empty and explained instead of wrong.
  - **Negation:** "not", "no", "non-" or "without" is one of the three words before the level, or "doesn't/don't need" ends within them ("doesn't need to be senior").
  - The check reads the model's own seniority, before "true for everyone" drops it, so "any level from junior to staff" isn't flagged.
  - The tests failed before the guard existed.
  - After the guard: 6/6 runs of the contradiction brief return 0, and nothing else changed (31 briefs × 3 runs, twice).
- Alternatives: adding the level back as a filter (the result would be the same for this brief, but the server would be writing filters); more prompt text (didn't hold; see "M6 eval results and what's left" under Testing and eval); effort medium (no better, and no faster).

### 2026-10-09: cost per search, measured (M13)
- Why: the README quotes a cost per search, so it comes from measured tokens, not PLAN.md § 3.10's estimate. Claude Haiku 5.5 prices for prompts up to 100K tokens: $0.10/M input, $0.50/M output, cache reads 0.1× ($0.01/M), 1-hour cache writes 2× ($0.20/M). Tokens are from the M13 `npm run eval` (44 calls, all cache hits):

  | Part | Tokens per call (mean) | Cost |
  |---|---|---|
  | Cached prompt and schema, read | 8,896 | $0.0000890 |
  | Uncached input (date line and brief) | 46 | $0.0000046 |
  | Output | 197 (p95 244) | $0.0000985 |
  | **One call** | | **$0.000192** |
  | Hedge: a second request on 7 of 44 calls, counted as fully billed | +16% | +$0.000031 |
  | **Per search** | | **≈ $0.00022**, about 4,500 per dollar |

  - The hedge row is an upper bound: billing for an aborted request couldn't be confirmed (M12). Today's 16% is above the ~5% expected in M12 because the model's median is slower today (1.79 s).
  - **Not per search:** writing the cache costs 8,896 × $0.20/M ≈ $0.0018 (plus one call's output) whenever the 1-hour cache has expired. `make dev`'s warm-up pays it at start, and the server's warm-up then reads it.
  - PLAN.md § 3.10 estimated $0.00015 with ~4k cached tokens. The real prompt plus schema is 8.9k, and reading it is still under half the cost.
- Alternatives: quoting the estimate (it counted half the prompt); counting the hedge only when it wins (a cancelled request may still be billed).

## Free-plan quota

One search per company, held under concurrency; paging never counts.

### 2026-10-08: quota and stored searches (M5)
- Why:
  - **One conditional UPDATE takes the free search** (`… set searches_used = searches_used + 1 where company_id = $c and (paid or searches_used < 1)`). Its row lock serialises callers, and READ COMMITTED re-checks the condition against the winner's committed row. **50 concurrent `reserve_search` calls through PostgREST with one token → exactly 1 success and 49 `P0402`s.** Mutation check: a check-then-update version with a 50 ms gap handed out 7 searches, and the test failed.
  - **Stale reservations:** a search still pending after 2 minutes belongs to a dead request (the LLM call times out after seconds). The next `reserve_search` deletes it and decrements the counter in the same transaction, so a crash can't eat the free search. Locks are always taken in the order searches → usage (reserve, release), and `complete_search` locks only its search row, so there is no deadlock cycle.
  - **Release deletes the pending row** rather than adding a third status: an abandoned search has no results to page. Complete takes `for update` on the search, so complete and release are mutually exclusive, and both are refused once a search is done.
  - **`complete_search` returns page 1 plus `searches_remaining`** by calling `get_search_page` and `get_plan`: one round trip for a new search, and the card SQL lives in one place. Both readers are SECURITY INVOKER (RLS applies when a recruiter calls them) **and** filter explicitly by `private.current_company_id()`, so they stay correct when called from inside the DEFINER function, where the owner bypasses RLS.
  - **Error codes:** `P0402` → 402. `42501` covers "no such search for your company", "not pending" and "not a recruiter", and maps to 404. The API checks 403 before any RPC, so a recruiter never sees the "not a recruiter" case as a 404. A page outside 1–10,000 → `23514` → 400. Past the last page returns an empty `results`.
  - **Every reservation counts, paid or not** (A6), so a company that searched while paid has 0 left after cancelling. `past_due` and any status other than `active`/`trialing` read as free (A5); both are tested.
  - The tests use throwaway companies with real recruiter logins (`tests/integration/helpers/tenant.ts`, via the auth admin API), so asterwell's and glenfold's counters are never touched.
- Alternatives: `select … for update` and then a separate update (correct, but two statements where one suffices); an advisory lock per company (it wouldn't protect direct PostgREST writes, which can't happen anyway because usage is select-only, but the row lock is already there); counting searches rather than keeping a counter (needs a lock on something regardless, and a deleted search would change the count).

### 2026-10-14: A per-recruiter search rate limit in reserve_search
- Why: on Paid, nothing bounded how fast one login starts searches. Each one costs a model call (brief) and writes up to 5,000 `search_results` rows. The demo logins are public, so one script on a paid demo company could run up the model bill or fill the free-tier database (about 250 KB per wide search). `reserve_search` now refuses a recruiter's 21st search within a minute, or 101st within an hour, with `P0429` → 429 `rate_limited` and `Retry-After: 60`. The worst case is then 2,400 searches a day per login, about $0.50 of model spend.
  - **Where:** in the same SQL call that takes the quota, after the `company_usage` UPDATE. That row lock already serialises a company's reservations, so the count sees every committed search and a burst gets exactly 20 (`quota.test.ts`: 25 concurrent → 20 + 5 `P0429`; `contract.test.ts`: 21 concurrent refines → 20 × 200 + one 429). A refusal rolls back the increment, and the 402 still comes first on Free. A new index on `(recruiter_id, created_at desc)` keeps the hour count cheap.
  - **Per recruiter, not per company,** so a colleague isn't blocked. Edits count too: they also write ranked results. 20 a minute is far above a person tapping chips, and above every suite (at most 15 per login per minute; the bench, 20 briefs a run, now signs in fresh for each run). Released searches (a model outage) are deleted, so they don't count.
  - **The firewall adds a per-IP layer in front:** a WAF rule on `POST /api/search*`, 30 a minute per IP, staged in `log` mode (Vercel's guidance: log, review, then enforce). On Hobby, WAF rate limits can only key on IP or JA4. Keying on a header (the recruiter's token) is Enterprise-only, so the per-recruiter part has to live in our own code.
- Alternatives: the Vercel Rate Limiting SDK keyed by user id (works only on Vercel, so `make dev` and the suites couldn't exercise it, and it adds a dependency); limiting only `brief` searches (edits also write up to 5,000 rows); a token bucket (more state for no visible difference at these numbers).

## API

Thin routes, one error module, and 404 for anything another company owns.

### 2026-10-08: API auth verifies the token locally with `getClaims`, then looks up the recruiter
- Why: local access tokens are ES256-signed, so `auth.getClaims(token)` checks the signature and expiry against the auth server's JWKS, which supabase-js caches per process for 10 minutes. Measured on this machine (20 sequential calls): `getClaims` p50 0.9 ms (the first call fetches the JWKS, 56 ms); `getUser` p50 76 ms, max 141 ms, because it is a round trip to GoTrue in Docker. Paging would otherwise spend most of its budget on auth. After the claims check (`role = 'authenticated'` and a `sub`), one `recruiters` select runs as the user (RLS: own row only). No row → 403. Every later query runs with that token, so PostgREST verifies it again and applies RLS. A token PostgREST rejects in between (`PGRST301`–`303`) maps to 401 in `http.ts`. A JWKS fetch failure is a 500, not a 401, so an auth outage doesn't tell recruiters to sign in again.
  - **Cost:** a signed-out session's token stays usable until it expires (`jwt_expiry` 86,400 s), which is also true of PostgREST itself. Sign-out isn't in scope.
- Alternatives: `getUser` per request (checks revocation, but costs ~76 ms on every call); a `whoami` RPC (it would change the fixed EXECUTE allowlist); verifying the JWT ourselves with a JWT library (a new dependency doing what supabase-js already does).

### 2026-10-08: API conventions (M7)
- Why:
  - **Thin routes.** Every handler is `handler(async (req, ctx) => …)`: `requireRecruiter` → parse → one `lib/server` call → `json()`. Anything thrown becomes a response in `http.ts`, the only module that builds error bodies or maps Postgres codes (22P02/23503/42501 → 404, 23514 → 400, P0402 → 402 with `plan: "free", searches_remaining: 0`, PGRST301–303 → 401). Any other error is a 500 with a fixed message, and the log line carries only the error's name, code and message, never the request. All responses send `Cache-Control: no-store`.
  - **Order: 401 → 403 → 400 → 402/404.** Auth comes before the body is read. The body is read at most 32 KB and must be a JSON object. Bad page numbers are checked before ids. Refine validates `filters` against the canonical schema before `reserve_search`, so bad input never spends the free search.
  - **400, not 413, for an oversized body.** The contract lists 400 for a bad brief, and a huge brief should get the status the contract names.
  - **Unknown request keys are ignored, not rejected** (`z.object`). The contract fixes what we read, and a client sending an extra field shouldn't fail. `Filters` stays strict, because a typo there (`role`) would silently widen a search.
  - **Response shapes are parsed with zod at the server boundary** (`lib/shared/api.ts`). A response therefore contains exactly the contract's keys: `POST /api/search` drops the `brief`/`page`/`per_page` that `complete_search` also returns. M9's client reads the same types. Stored filters are only required to be objects on read, so a later vocabulary change can't make old searches unpageable.
  - **Ids:** a path id that isn't a uuid is a 404 without a query, and so is a candidate id over 64 characters. Candidate ids go through `sanitizeText`. Every update or delete does the explicit visibility lookup first and then checks it changed exactly one row (one extra round trip, ~3 ms). Another company's id and an id that doesn't exist get byte-identical 404 bodies, and the contract test asserts this for all 8 id routes.
  - **Shortlist names:** sanitised, with runs of whitespace (a pasted newline) collapsed to one space, then 1–80 characters. The DB already rejects newlines in names, so collapsing them is friendlier than a 400.
  - **Refine filters are validated and normalised, not grounded.** A chip the recruiter chose is meant, even if the brief doesn't say it.
  - **`POST /api/billing/events` is M8.** It needs its own migration (`apply_stripe_event`) and the Stripe SDK.
- Alternatives: middleware for auth (Next 16 has no middleware here, and CLAUDE.md puts auth in the handlers); returning PostgREST rows as they come (the shapes would drift with any `select` change).

### 2026-10-08: a NUL in a path id was a 500; malformed percent-encoding still is (Next)
- Why: probing hostile path values against `make dev` found two 500s:
  - `POST /api/shortlists/{id}/people/cand_0002%00` returned 500 (`22P05` "unsupported Unicode escape sequence"). The lookup had matched `cand_0001`, because the NUL gets truncated somewhere between PostgREST and Postgres, and then the insert failed. Path ids now go through `sanitizeText` like every other input. The contract test failed before the fix.
  - A path segment that isn't valid UTF-8 when decoded (`/api/people/%ED%A0%80`) is rejected by Next's router before any route code runs, with a plain-text 500. Next means it to be a 400 (`base-server` maps its `DecodeError` to 400), but the error reaches the outer handler as a different class instance. Catching it would need middleware or a custom server, which CLAUDE.md rules out. No data is touched and the server keeps serving. Briefs arrive in JSON bodies, where `sanitizeText` handles lone surrogates.
- Alternatives: a `proxy.ts` that rejects malformed paths (against the "no proxy/middleware" rule); mapping `22P05` → 400 (it hides the missing sanitisation instead of fixing it).

### 2026-10-08: `GET /api/me` for the header's company name
- Why: the header shows the recruiter's company, and no contract route returns it. `GET /api/me` returns `{email, company: {slug, name}}`. The company is read as the recruiter (RLS: own company only), and the email comes from the verified token's claims. It's listed in PLAN.md (A11, § 3.7), and the contract tests cover 401/403 like every other route, the shape, and both seeded names. The browser never queries PostgREST for data: its Supabase client is used only for signing in.
- Alternatives: reading `companies` from the browser with supabase-js (works under RLS, but adds a second data path); deriving the name from the email domain (wrong for any other account).

## Billing: the Stripe webhook

Verified, idempotent and order-safe; the plan follows the subscription's status.

### 2026-10-08: Stripe webhook verification (M8)
- Why:
  - **The secret is read on every request** (`webhookSecret()` → `env.ts`), so the server's own `STRIPE_WEBHOOK_SECRET` applies without a rebuild. Unset or blank → 500 `webhook_not_configured`; the log names the variable, never a value.
  - **Raw bytes only:** the body is read whole, at most 1 MB, with `readBody` (split out of `readJsonObject`, which now uses it), and is never parsed before verification.
  - **`Stripe.webhooks.signature.verifyHeader(raw, header, secret, 100 years)`, then our own `JSON.parse`.** `constructEvent` parses inside the same call, so a signed body that isn't JSON would become an unhandled 500; now it's a 200 that changes nothing. The tolerance is explicit because 0 means "300 s" in `constructEvent` and "skip the check" in `verifyHeader`, and stripe-node marks the latter for change in its next major. Measured: the sample (signed 2026-10-05) and an event signed 10 years ago both verify, and so does a header carrying a second `v1` from another secret (rotation).
  - **Statuses:** no header → 400 `missing_signature`. Anything `verifyHeader` rejects → 400 `invalid_signature`: another secret, a tampered, re-serialised or empty body, a trailing newline, a changed `t=`, or no `v1`. **Every validly signed event → 200 `{received:true}`**, including repeats, stale events, ignored types, unknown companies and bodies with no event id. A database failure is a 500, and it deliberately doesn't go through `DbError`'s 4xx mapping, so Stripe retries it.
  - `stripe` 22.6.2 comes from the stack table. It has no native parts (`check:lockfile` passes) and also provides `generateTestHeaderString` for the tests and `replay:stripe --resign`.
- Alternatives: an HMAC by hand with `node:crypto` (about 20 lines, but it would have to match Stripe's header parsing exactly: several `v1` values, schemes, `t=`); `constructEvent` (see above); a 0 tolerance (see above).

### 2026-10-08: which Stripe event types change the plan
- Why: the brief makes the plan a function of the subscription's status, and Stripe reports every status change as a `customer.subscription.*` event, so those are the source of truth.

  | Event | Effect |
  |---|---|
  | `customer.subscription.created` / `updated` / `paused` / `resumed` / `trial_will_end` / `pending_update_*`, and any future `customer.subscription.*` | Apply `data.object.status` |
  | `customer.subscription.deleted` | `canceled`, whatever status it carries |
  | `checkout.session.completed` or `.async_payment_succeeded` with `mode: subscription`, `payment_status` `paid` or `no_payment_required`, and a subscription id | That subscription becomes `active` |
  | The same checkout with `payment_status: unpaid`, a `payment`-mode checkout, `checkout.session.expired`, `.async_payment_failed` | Recorded, ignored |
  | `invoice.*` (`paid`, `payment_succeeded`, `payment_failed`, …) | Recorded, ignored |
  | `customer.*`, `payment_intent.*`, `charge.*`, `product.*`, anything else | Recorded, ignored |

  - **Checkout counts:** Stripe documents `checkout.session.completed` as the provisioning signal, so anyone who simulates "checkout → paid" with only that event gets paid. Acting on it is safe because a checkout completes once, when its subscription starts, so it can never be newer than that subscription's cancellation. In a same-second tie it ranks after `created` (the payment went through) and before `updated` and `deleted`.
  - **Invoices don't count:** an invoice can be paid after its subscription has ended (a final invoice, or an open one paid late), so acting on `invoice.paid` would revive a cancelled company. `invoice.payment_failed` doesn't end a subscription: Stripe retries, and reports `past_due` as `customer.subscription.updated`. Whenever the status really changes, Stripe also sends the subscription event.
  - **`customer.deleted`:** Stripe cancels that customer's subscriptions and sends `customer.subscription.deleted` for each one.
  - Statuses are stored as sent (trimmed and lowercased). Only `active` and `trialing` mean paid, so a status Stripe adds later reads as free.
  - Tested in `tests/unit/billing.test.ts` (type → change) and `tests/integration/billing.test.ts` (the plan after each event).
- Alternatives: subscription events only (a checkout-only flow would stay free); `invoice.paid` → active and `invoice.payment_failed` → free (the first revives cancelled subscriptions; the second drops paying customers during Stripe's retries).

### 2026-10-08: `apply_stripe_event`: idempotent, ordered per subscription, one transaction
- Why:
  - **Idempotency:** the first statement inserts the event id into `processed_stripe_events` with `on conflict do nothing`, and a repeat returns `duplicate`. A concurrent repeat blocks on the primary key until the first delivery commits. Measured: 20 concurrent `applyStripeEvent` calls with one event → exactly 1 `applied` and 19 `duplicate`. Through the route, all 20 got 200.
  - **A per-subscription advisory transaction lock** (`hashtextextended` of the subscription id) means the read (company fallback, stale check) and the upsert can't interleave, even before the row exists. Locks are always taken in the same order (event key → advisory → row), so there's no cycle.
  - **Order key `(created, rank, event id collate "C")`.** The rank comes from `private.stripe_event_rank`: `created` 1 < paid checkout 2 < any other subscription type 3 < `deleted` 4. An equal or older key is `stale`. The stored side's rank is derived from `last_event_type`, so no new column is needed.
  - **Company:** the `metadata.company` slug (case-insensitive). Without it, or when it names no company we have, the event goes to the company that already holds the subscription. Without either, the outcome is `unknown_company` and nothing changes. The company comes from the event, not `auth.uid()`. CLAUDE.md's DEFINER rule targets functions recruiters call, and this one is executable by `service_role` alone (privileges test) and is reached only after the signature has been verified.
  - **Outcomes are recorded per event:** applied, stale, ignored, unknown_company. A newer event that omits `customer` or `current_period_end` keeps the stored value.
  - **TypeScript validates first:** `sanitizeDeep`, ids ≤ 255 characters, status ≤ 64, timestamps up to 9999-12-31. So a signed event can't trip a CHECK (23514, which would map to 400) or a timestamp overflow (500). Malformed optional fields read as absent.
  - **Mutation checks** (the function replaced in the local DB, then restored from the migration): with no ordering, 14 tests fail; with no idempotency, 3; with no rank, 5 (the same-second tests); with no company fallback, 1.
- Alternatives: a bare `insert … on conflict do update … where newer` (correct for the row, but the company fallback and the `stale` outcome need the read, and an event with no metadata could be lost to a race on a row that doesn't exist yet); a jsonb argument parsed in SQL (typed parameters let Postgres check types, and TypeScript has already validated them).

### 2026-10-08: M8 verification and the replay script
- Why:
  - **`tests/integration/billing.test.ts` (39 tests)** calls the route handler directly. It covers: the sample byte for byte against the § 3.6 table; re-signed with the sample secret; re-signed under another secret (the original signatures → 400 and nothing recorded, then the same table); all 120 orderings → one final state (asterwell `canceled` via `evt_sample_asterwell_2`, glenfold `active` via `evt_sample_glenfold_2`); all five at once, 10 rounds; repeats after the fact; bad signatures; the missing secret; >1 MB; every status; two subscriptions; ties; checkout, invoice and other types; company resolution; sanitisation; concurrency; and recruiter/anon RPC → 42501. The sample names asterwell and glenfold, so the test saves their billing rows and the sample's event ids, clears them per scenario and restores them afterwards. Everything else uses throwaway companies.
  - **`npm run replay:stripe`:** it posts the file in order, byte for byte, and prints the HTTP status and both companies' `/api/plan` after each event. Its "expected" column comes from a small TypeScript model of the ordering rules, started from the database's billing state, so `--only` and a non-fresh start are judged correctly. It shares event reading with the server but not the ordering, which is SQL there. The integration test hard-codes the § 3.6 table instead, so the two check each other. `--reset` clears asterwell's and glenfold's subscriptions and the file's event ids; `--resign` re-signs with `$STRIPE_WEBHOOK_SECRET`; `--only` takes a position, an id or a description prefix (`asterwell-subscribe`).
  - **Against `make dev`:** `--reset` passes all 5 rows and the final check. Against a second server started with a different secret, the sample signatures get 5 × 400, and the script prints the `--resign` hint; with `--resign`, all 5 pass.
  - **`tests/e2e/contract.test.ts`** adds the route's contract: no token needed; missing or bad signature → 400; a signed event, its repeat, a cancellation and an `invoice.paid` → 200 `{received:true}`, with `/api/plan` following.
- Alternatives: a replay table hard-coded from PLAN.md (wrong for `--only` or a non-fresh start); replaying on asterwell/glenfold inside the e2e suite (it would change the seeded companies' state under a running demo).

### 2026-10-14: Stripe Checkout in test mode, with a one-hour demo upgrade
- Why: Upgrade only explained how upgrading would work, so the live demo couldn't show the most interesting flow end to end. Om approved relaxing "signature verification only, no API calls" (2026-10-14). Upgrade now opens Stripe's hosted Checkout in test mode (card 4242 4242 4242 4242), and Paid companies get Manage billing (Stripe's portal). **The plan still changes only when a signed webhook arrives:** Checkout sets `metadata.company` on the session and on its subscription, and `apply_stripe_event` resolves that slug as before. Coming back to `/?upgrade=done` only reopens the dialog, which polls `/api/plan` until the webhook lands.
  - **The demo upgrade ends after an hour** (Om's choice, 2026-10-14). The logins are public, so one visitor's test payment would otherwise make the company Paid for everyone, and later visitors would never see Checkout. Checkout can't set `cancel_at` (not a `subscription_data` field in the API reference). So once the webhook *applies* a `checkout.session.completed` that carries `metadata.company`, the handler calls `subscriptions.update(cancel_at = now + 1 h)`, keyed on the event id. Stripe's `customer.subscription.deleted` then makes the company Free through the usual path. This is best effort: a failure is logged and the webhook still answers 200, and the company then stays Paid until someone cancels in the portal. Sessions without our metadata, and every other event type, are never touched. So other test-mode subscriptions on the same Stripe account can't be cancelled by this app.
  - **Test mode only:** `lib/server/billing/stripe.ts` accepts only `sk_test_`/`rk_test_` keys and treats anything else as not configured. The key never appears in a log line (unit-tested). Without it, Upgrade answers 503 `checkout_not_configured` and everything else works; `make dev` warns. A paid company gets 409 before Stripe is involved.
  - **One price, found by lookup key** (`rosterly_paid_monthly`, $29 a month) and created on first use. Inline `price_data` would add a product to the dashboard every time Checkout opens. A race between instances re-reads the price after the unique-lookup-key failure.
  - **Stripe errors** become 502 `stripe_unavailable`, with only the error type and code logged (Stripe messages can quote parameters). An unconfigured test-mode portal is 503 `portal_not_configured`.
  - Checked at 390 px in Chromium: Upgrade shows the price, the test card and "Upgrade with Stripe". Without a key it shows the 503 message inline. `?upgrade=done` reopens the dialog as "You're on Paid" with Manage billing, `?upgrade=cancelled` shows a toast, and both strip the parameter. Checkout itself, the portal and the one-hour end need a test-mode key and the Stripe webhook endpoint (Om's step), so they are not yet checked end to end.
- Alternatives: Stripe Payment Links (no per-company metadata unless pre-made per company, and no way to end the demo); keeping Upgrade explanatory (the flow a reviewer most wants to see stays invisible); ending the demo with a Vercel Cron that cancels old subscriptions (another moving part, and Stripe already has `cancel_at`).

## UI

Mobile-first behaviour, the free-plan flow and what the walkthroughs changed.

### 2026-10-08: chip edits are staged behind an Apply bar on Free and applied at once on Paid
- Why:
  - **Free:** every new result set uses the one search (A3), so edits are collected and applied together. The bar can't be missed:
    - it is an ink bar fixed above the tab bar (bottom centre on desktop) that says how many changes are waiting and what applying costs ("Uses your free search", or "Free search used · Upgrade");
    - the filter heading gets an "Edited · not applied" badge;
    - removed chips stay visible, struck through, and new chips get a dashed outline;
    - results dim, with the note "Showing results for your filters before the changes".
  - **Paid:** an edit costs nothing, and refine never calls the model. Measured through the production server on a paid company, 20 refines: **p50 40 ms, p95 92 ms, max 144 ms**. Staging there would add a tap to every edit and gain nothing. Each applied edit gets its own URL (`?s=`), so the browser's Back undoes it (checked in Playwright).
  - **The bar still appears on Paid when there is a draft:**
    - an immediate edit that fails (network error or 500) stays staged, so Apply retries it;
    - a 402 (the plan dropped to Free mid-session) keeps the edit staged and opens Upgrade;
    - once a draft exists, further edits join it instead of running.
  - Applying a draft with no substantive filter is disabled ("Add at least one filter to search"), so the free search is never spent on a search that can only return 0.
- Alternatives: staging on both plans (one model, but every paid edit costs an extra tap); applying at once on both (the first × on Free would spend the search without warning).

### 2026-10-08: search UI behaviour (M9)
- Why:
  - **The search on screen lives in the URL** (`?s=<id>&page=N`). Search pages are cached for good (frozen ranks), and the next page is prefetched.
  - **Back restores the page and the scroll position.** Opening a candidate stores `{search:page, scrollY}` in sessionStorage, and returning to that page restores it. That works with our Back button (history back after an in-app navigation, a fixed link otherwise) and with the browser's. Checked in Playwright at 390 and 1280 px: from ~2,100–2,400 px down page 1, both Back paths return to the same pixel, and back from page 2 lands on page 2.
  - **Free plan, with no surprises:**
    - Search, Apply, "Search without it" and a saved search's "Run again" each say "Uses your free search".
    - With nothing left, they open Upgrade without calling the API, after refetching the plan in case Stripe has just upgraded the company. A 402 from the server opens it too.
    - Example briefs fill the box but never run. They were written for the UI and are not from queries.json.
  - **The Upgrade dialog has no checkout button,** because we never call Stripe's API. While open, it polls `/api/plan` every 3 s and switches to "You're on Paid". When a refused search opened it, "Run the search now" re-runs that search. The plan also refetches when the window regains focus.
  - **Chips:** one per value, except where one chip reads better:
    - `skills_any` is one "A or B" chip;
    - 4+ roles are one chip ("Any engineering role" for the 7 "… Engineer" roles that "engineers" maps to).
    
    Long editor lists open with the chosen values at the top. Editors offer only vocabulary values, so an edit can't create a filter the data lacks.
  - **Cards show `current_title`, not `headline`:** headlines mostly repeat the title, employer or skills, which the card already shows. On phones, skills and the action share a full-width row (at most 4 skills plus "+N"), so names and titles aren't squeezed.
  - **Shortlist ticks are optimistic** and the checkbox is the confirmation; there is no toast, because one covered the sheet on phones. Toasts sit at the top on phones, so they never cover a sheet or the Apply bar.
  - **Images:** plain `<img>` with an initials or letter fallback if loading fails. The original image host's bot check returned 403 to HeadlessChrome, so the Playwright screenshots use a desktop/iPhone user agent.
- Alternatives: search state in React state only (refresh and back would lose it); relying on the browser's own scroll restoration (results render after their data loads, so it lands too early).

### 2026-10-08: UI dependencies and the font (M9)
- Why:
  - **Packages, pinned exactly:** `@tanstack/react-query` 5.103.2, `radix-ui` 1.6.7 (Dialog, Popover, Checkbox, DropdownMenu and Slot from one package rather than six `@radix-ui/*` ones), `lucide-react` 1.47.0, and `clsx` 2.1.1 + `tailwind-merge` 3.7.0 (shadcn's `cn`). Each is the newest release at least two weeks old; newer ones were days old. None has native parts, and `check:lockfile` passes.
  - **Hand-written instead of extra packages:** vaul, cva, sonner and tw-animate-css were left out.
    - The bottom sheet is the Radix dialog with sheet classes below 640 px.
    - Button variants are a plain record.
    - Toasts are about 60 lines.
    - Animations are 8 keyframes in `globals.css`, with reduced motion respected.
  - **Inter Variable** (Latin subset, 48 KB, OFL, from `@fontsource-variable/inter` 5.2.8) is committed under `app/fonts` with its licence and loaded with `next/font/local`, so `next build` never fetches fonts on a fresh machine.
- Alternatives: `next/font/google` (the build needs the network); the system font stack (looks different on every device); the shadcn CLI (interactive, needs the network, and generates code that would be hand-edited anyway).

### 2026-10-09: the Upgrade dialog fits on a desktop screen without scrolling (M11)
- Why: on Om's 1080p walkthrough the dialog scrolled. A 1080p laptop at 125–150 % scaling gives a viewport of about 1536×730 to 1280×640 CSS px, and the dialog is capped at 85 % of the viewport height. Changes:
  - "How upgrading works" is one line per step (icon + sentence), not a title plus a sentence.
  - The Free/Paid cards use shorter lines and tighter padding. On desktop the dialog is `max-w-xl`, so no card line wraps.
  - The description appears only when a search was refused ("paging stays free, upgrade to run new searches"). Otherwise the status row and the cards already say it.
  - Measured with Playwright: opened from the pill it is 495 px tall, and opened after a refused search 509 px. The body does not scroll at 1920×960, 1536×730, 1366×650, 1280×800 or 1280×640. On a 390 px phone it is still a bottom sheet (565 px, which also fits on an 844 px screen).
- Alternatives: a two-column dialog (wider, but cramped at 640 px); dropping the plan cards (CLAUDE.md's UI rules ask the dialog to explain the free plan).

### 2026-10-09: the candidate page knows which search or list opened it (M11)
- Why: a result card links to `/people/<id>?s=<search>&page=N`, and a shortlist card links to `…?list=<id>`. The profile then:
  - shows a labelled back link at the top ("Back to results", "Back to shortlist", otherwise "Back to search"). It is 40 px tall on phones and dark text, not the old grey "Back";
  - highlights the skills that search asked for, exactly like the result cards (indigo, ticked, listed first, "matches your search" for screen readers). The filters come from the stored search page, which is already cached when you arrive from the results; loading it never uses a search.
  - Both survive a refresh, because they come from the URL rather than memory.
- **The back link is a real link to its destination.** It goes back in history only when the previous in-app page *is* that destination (`cameFrom`, comparing path and sorted query). That keeps the scroll restore and adds no history entry. Before, any in-app history meant `router.back()`, so results → profile → "On <list>" → browser back → "Back" went to the list. Checked at 390 and 1280 px: back returns to the same pixel (888 → 888, 1047 → 1047), and after a refresh on the profile, Back still lands on the results.
- Alternatives: sessionStorage for the context (lost on a new tab, invisible in the URL); always pushing the results URL (adds a history entry, so browser Back would return to the profile).

### 2026-10-09: M11 walkthrough of the five product checks, and what it changed
- Why: Playwright at 390×844 (iPhone UA, 2×) and 1280×800, on throwaway free and paid companies (deleted afterwards). Every data view was put into its loading, empty and error states (delayed or failed `/api/search`, `/api/people`, search-page 500, unknown search, unknown person, model 503). Each flow asserted its outcome, and no page logged an error. Fixes:
  - **The chip editor's Apply was off screen on a 1280×800 desktop** (bottom ≈ 823 px). The popover is now capped at Radix's `--radix-popover-content-available-height`, and the option list shrinks, so header and footer always show (bottom 784 px). This was the only real bug found.
  - **Save search is hidden when nothing can be searched** (a vague brief has no filters to save). It still shows for an unsupported brief that has real filters.
  - **The results range reads "1–20 of 30" / "21 of 21".** The "page N of M" next to it repeated the pager below.
  - **The unapplied-edits badge says "Not applied"** (was "Edited · not applied"), so on a 390 px phone it fits on one line with "Understood as" and Save search.
  - **The shortlist picker's "Tick the lists…" line shows only when there are lists.** With none, the empty-list note says what to do.
  - **On phones the profile's avatar sits beside the name** (64 px), so skills start about 50 px higher.
- **The Playwright smoke is committed** (`npm run test:ui`, `tests/e2e/ui.spec.ts`, `@playwright/test` 1.63.0 pinned; 1.64.0 was two days old). It runs at 390 px on a throwaway paid company: sign in → search → profile shows "Back to results" and the highlighted skill → back → edit the location chip in its sheet → page 2. Without a model key it skips and says so. It passed in 9 s against the production server. It needs `npx playwright install chromium` once per machine, and it is not part of `make setup`.
- **Not done here: the real-phone check over the LAN** (PLAN.md M11 acceptance). It needs Om's phone.
- Alternatives: the plain `playwright` library inside Vitest (no trace on failure, and its own browser lifecycle to manage); skipping the smoke (it's first on the cut list, but there was time).

## Security suite and secrets

What `npm run test:security` proves, and how keys stay off the browser and the terminal.

### 2026-10-08: heads-up for M10: supabase-js puts the literal `sb_secret_` in the client bundle
- Why: supabase-js checks key types with `startsWith("sb_publishable_") || startsWith("sb_secret_")`, so one file in `.next/static` contains the prefix as a string literal. The real secret key is not in the bundle (checked by value, without printing it), and neither are the names `SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `STRIPE_WEBHOOK_SECRET` or `DATABASE_URL`. PLAN.md § 3.8's scan fails on the bare pattern `sb_secret_`, so M10 should match the prefix only when key characters follow it, and keep checking the actual values.
- Alternatives: none for M9. The browser needs supabase-js for sign-in.
- Outcome (M10): the scan matches `sb_secret_` only when 8 or more key characters follow it, still checks every secret by value, and prints a note for files that hold the bare literal (`scripts/security-check.ts`).

### 2026-10-09: M10 security suite: results, and two fixes to the secret scan
- Why:
  - **`npm run test:security` against the production server** (`next start`, the server `make dev` runs, here on port 3100): **229 attempts, all pass**, in 33 s. Again after a full `make setup`, against `make dev` itself on port 3000: 229/229 in 40 s. That is 13 attempts on our API, 93 on PostgREST/RPC/GraphQL/auth admin with asterwell's token, 28 as anon, 4 on the quota RPCs, 21 byte-for-byte checks of glenfold's rows, its API responses and the shared data, 24 secret-scan rows, 28 hostile-brief rows (15 model calls as a throwaway paid company) and 18 cleanup checks showing asterwell and glenfold exactly as before. No attack succeeded on the first run either.
  - **The first run had 14 secret-scan failures, none of them a leak.** Next 16 checks the `_rsc` cache-busting value against the router headers (`rsc`, `next-router-prefetch`, `next-router-segment-prefetch`, …) and answers any other value with a 307 to the right one (`?_rsc` when only `rsc: 1` is sent). The scan had been reading empty 307 bodies, so no RSC payload was actually scanned. It now follows that redirect once, only to the same origin and path, with the same headers.
  - **`/_global-error`** is Next's built-in global error page (the app has no `global-error.tsx`). It answers 500 to HTML and RSC requests by design, and the server logs nothing. The scan accepts 500 for that route only and still scans its body; any other 5xx fails, because the scan would then be reading an error page instead of the page.
  - **Mutation check:** with `ANTHROPIC_API_KEY` set to `"$Sreact.fragment"` (in every RSC payload, but JS-escaped in the HTML), all 18 page rows fail with "the value of ANTHROPIC_API_KEY (RSC); … (RSC prefetch)", and none fails for the HTML. Before the fix this run would have passed.
  - `supabase status -o json` is read once per run (the secret scan and the hostile briefs share it). The three "every row not asterwell's" attempts now name their filter. One was labelled "no filter" but had always sent `company_id=neq.asterwell`, because with no filter asterwell's own probe list is a legitimate row.
- Alternatives: computing the `_rsc` value ourselves (it's Next's internal hash of the header values and can change between versions; following the redirect lets Next supply it); skipping `/_global-error` (anyone can fetch it, so its body is scanned too).

### 2026-10-09: `make setup`, `make dev` and `make reset` keep the Supabase CLI's keys off the terminal
- Why: `supabase start` prints the stack's status on stdout, even when the stack is already running. For people it's a table with the secret key and the DB URL with its password. When the CLI detects an agent (2.119 reads variables such as `CLAUDECODE` and `AI_AGENT`; `--agent auto|yes|no` overrides) it prints JSON that adds the service-role JWT and the JWT secret. Progress lines go to stderr in both modes. Errors go to stderr for people, but come as `{"_tag":"Error"}` lines on stdout in agent mode.
  - `scripts/supabase-quiet.mjs` runs `node_modules/.bin/supabase` (the pinned CLI) and appends stdout and stderr to `.logs/supabase.log` (mode 0600; `.logs/` is git-ignored). The terminal shows:
    - a "▸ supabase start (full output in .logs/supabase.log)" line;
    - the stderr lines that contain none of key, secret, token, passw, jwt, `eyJ`, `sb_`, `whsec_`, `sk-ant-` or a `user@` URL;
    - agent-mode error messages, through the same filter;
    - "✔ … (1.9 s)", or "✖ … failed (exit N)" pointing at the log. The exit code is passed through.
  - Dropped as noise: the CLI's update notice (setup must stay on 2.119.0), the "Stopped services" list (the services `config.toml` turns off) and Docker's per-layer pull lines, if any reach stderr.
  - Checked on a running stack in both modes (`start`, `migration up --local`, an unknown command), then end to end with `make setup` (106 s, `npm ci` included) and `make dev`, with the agent variables unset as on a fresh machine. Each time the terminal output was scanned for every key value from `supabase status` and `.env.local`: clean. The log holds them.
  - The rest of the targets print no values: write-env prints names, the seed prints counts, check-env names missing variables, and `next build`/`next start` print URLs.
- Alternatives: `> .logs/supabase.log 2>&1` in the Makefile (it hides progress and errors too, so a new user would watch a silent 90 s cold start, and a failure would say nothing); filtering stdout (its format changes with agent detection, so a filter would have to recognise every format that carries a key); `--agent no` (it changes the format, not where the keys go).

## Speed

Paging under 100 ms, new searches under 2.5 s at p95, and a warm first search.

### 2026-10-08: speed follow-ups agreed for M12
- Why: Om moved the start-up warm-up (formerly Stretch S3) into M12, with a new acceptance check: the first search after `make dev` is under 3 s. The first call after a start takes 2.2–4.0 s when cold. The smaller-output schema stays in reserve and is used only if `npm run bench` shows new-search p95 above 2.5 s end to end.
  - **Tail latency, measured for M12:** in two of the three final eval runs (106 calls each), exactly one call took 10.3–10.6 s, while the rest had p95 1.86–1.94 s and a max of 2.3–2.5 s. 10.5 s ≈ the 8 s client timeout plus one ~2.4 s retry, so the 8 s per-attempt timeout is what sets the tail. M12 should measure it against a shorter per-attempt timeout.
- Alternatives: changing the timeout now (it belongs with the M12 bench, which measures end to end).
- Outcome (M12): the timeout and retry stayed as they were and a hedged request was added; the smaller-output schema wasn't needed (the hedge and bench entries below).

### 2026-10-09: the start-up warm-up runs in the server and, earlier, in `make dev` (M12)
- Why: the first model call with cold caches compiles the output schema's grammar and writes the prompt cache. A fresh machine starts like that.
  - **Measured with cold caches:** a temporary build (not committed) added a per-start nonce to the cached prompt and a never-chosen extra enum value to the schema. The first search after `make dev`, sent 5 s after the server answered, took **3,729 / 3,766 / 3,228 ms without a warm-up** (all over 3 s) and **2,225 / 2,223 / 2,168 ms with it**. The warm-up call itself took 3.3–3.9 s. A nonce in the prompt alone (prompt cache cold, grammar warm) cost only ~0.3–0.5 s, so the grammar compile is most of the cold cost.
  - **The server can't start early enough on its own.** Next calls `register()` about 0.2–0.3 s before "Ready", so a search sent the moment the server answers overlapped the warm-up: 3,191 and 2,815 ms. `make dev` therefore also starts the same warm-up (`scripts/warmup.ts`) in the background as its first step, alongside the preflight, `supabase start` and write-env (~4–5 s). It finished 4.5–5.2 s after the start, around Next's "Ready" (4.9–5.3 s), and the first search sent with no delay took **2,185 / 1,924 / 2,006 ms**.
  - **`instrumentation.ts` stays** (PLAN.md M12): it covers a plain `npm start`, and with the caches warm its call is a cheap cache read. `register()` is synchronous and only starts the import, because Next waits for it before serving. Next skips it during `next build` (checked: no warm-up line in the build output).
  - **`warmUp()` calls the parser directly:** no database, no company, no search, nothing of asterwell's or glenfold's. It never throws; it logs either "model ready in N ms (prompt cache written | already warm)" or a fixed reason (the parser's error messages are fixed strings, anything else is named only). `scripts/warmup.ts` reads `.env.local` the way Next does (an exported value wins, checked) and does nothing without a key, because check-env already warns. Unit tests cover all of this, plus a brief that isn't in `data/queries.json`.
  - **The route doesn't share the instrumentation bundle's modules** (the grounding check's lazy setup ran again in the first search), so only state outside our JS modules can be warmed: Anthropic's prompt cache and compiled grammar, and the process's connection pool. So the warm-up doesn't run the rest of the pipeline.
  - **Cost:** about $0.002 per `make dev` when cold (8.9k tokens written at 2×), then a cache read (~$0.0002) for the second call.
  - **Limit:** the prompt cache lives 1 hour. On a server left idle longer, the first search writes it again (~0.3–0.5 s by the measurement above). The grammar cache wasn't measured past a few minutes.
- Alternatives: start-up waiting for the warm-up (the plan says start-up never waits); re-warming on a timer (an idle server would call the API forever, for a case no check covers); warming inside the route module at import time (an import side effect in every importer, and no better for Anthropic's caches).

### 2026-10-09: the grounding check skips aliases whose first word isn't in the brief (M12)
- Why: with the warm-up in place, the first search after a start still spent ~210 ms in postprocess (later searches 1–11 ms), and one search in the middle of a run spent 293 ms. The cause is `findMentions`. It ran all 286 alias and non-value regexes on every brief, each with two `[\p{L}\p{N}]` classes under `/iu`, and V8 compiles those lazily during the first few runs. Measured in plain Node: calls 1–3 took 205–348 ms each, then ~0.4 ms.
  - **Fix:** each regex is built the first time it's needed, and skipped unless the alias's first word occurs in the brief. Case-sensitive aliases are checked against the raw text, the others against `toLowerCase()` with ſ turned into s.
  - **Why it's exact:** under `/iu` an ASCII letter matches only its two cases, ſ (s) and K (the Kelvin sign, which `toLowerCase` already turns into k). This was found by testing every code point. Every alias is ASCII. Tests pin both facts, and check that every case-insensitive alias is still found in upper case, in title case and spelt with ſ and K. Two mutations each fail them: dropping the ſ mapping, and screening every alias against the raw text.
  - **Effect:** plain-Node calls 1–3 went from 290 / 290 / 205 ms to 7 / 16 / 10 ms. In the first search after a start, postprocess went from 206–215 ms to 10–20 ms.
- Alternatives: warming the regexes at import time in the route bundle (~700 ms of CPU in every importer, and the mid-run spike suggests compiled code can be dropped and paid for again); one combined alternation (it can't report equal spans such as "Illinois", as decided in M1).

### 2026-10-09: tail latency: a hedged model request, not a shorter timeout (M12)
- Why: in M6 about 1 call in 100 took ~10.5 s (the 8 s timeout plus a retry). Measured 100 natural calls per strategy, interleaved by brief with the order rotated, all sending the parser's exact request. Natural stalls are rare, so 5 more calls per strategy made their first attempt hang (a custom `fetch`).

  | Strategy | p50 | p95 | p99 | max | calls > 3 s | extra requests | cost per 1,000 calls |
  |---|---|---|---|---|---|---|---|
  | 8 s timeout, 1 retry (before) | 1,543 ms | 2,000 ms | 2,281 ms | 6,801 ms | 1 | 0 | $0.194 |
  | hedged at 1.8 s | 1,637 ms | 1,948 ms | 2,466 ms | 3,851 ms | 1 | 18 | $0.231 (+19%) |
  | 5 s timeout, 1 retry | 1,652 ms | 1,965 ms | 2,120 ms | 3,235 ms | 1 | 0 | $0.194 |
  | first attempt hangs (5 calls each) | 9.6–10.3 s | 2.9–3.6 s | | 6.7–7.6 s | | | |

  (In the last row the three ranges are the 8 s timeout, the hedge and the 5 s timeout, in that order.)
  - **Each strategy had one natural call over 3 s.** Under the 8 s timeout, a call crawled to 6.8 s without ever timing out. Under the hedge, a slow call was finished by the second request at 3.85 s. Under the 5 s timeout, the slow call took 3.2 s, which is under that timeout.
  - **A shorter timeout swaps one tail for another.** A call that would have answered at 6.8 s is killed at 5 s and started again (~7.3 s, paid twice). Cold first calls already take up to 4.0 s, so a 4 s timeout would cut those, and their retry would be cold too. It only helps a true stall, and only down to ~7 s.
  - **The hedge never kills a call:** the first keeps running. A stall ends at the hedge delay plus one call. p50 and p95 don't move. Billing for a cancelled non-streaming request isn't something I could confirm, so the cost column counts every extra request as fully billed (an upper bound).
  - **Delay 2.0 s, not the 1.8 s evaluated.** At 1.8 s the hedge fired on 18 of 100 calls and won once, because today's median (~1.6 s) sits close to it. 2.0 s is the measured p95 of a plain call. It should fire on ~5% of calls (estimated from the plain run's latencies), and a stall would end at ~3.5 s rather than ~3.3 s. `HEDGE_AFTER_MS` is the one constant to change.
  - **Semantics** (`hedged` in `parse-brief.ts`): the second request starts only on the timer, never after a failure, because the first request's SDK retry has already run. So errors surface exactly as before (A15). Once both are running, the search fails only when both have, with the first request's error. The other request is aborted. The 8 s per-request timeout and the 1 retry are unchanged. Unit tests with fake timers cover each case, and removing either the timer or the abort fails them.
- Alternatives: the 5 s timeout (see above); hedging at 1.8 s (about four times the extra requests for nearly the same tail); also hedging after a failure (it would double the requests during a 429/529 episode).

### 2026-10-09: M12 bench and before/after
- Why: `npm run bench` (`scripts/bench.ts`) measures from outside, like a browser, as a throwaway paid company, so asterwell and glenfold are never touched.
  - **New search:** 20 briefs written for the bench (5–2,453 results each), end to end.
  - **Paging:** every page of the 2,453-result search plus page 2 of the others, 137 requests per run.
  - **`--fresh=N`:** starts `make dev` N times in its own process group, waits until the server answers, then waits `--think` seconds (default 5; nobody signs in and types a brief faster). It then loads `/api/me` and `/api/plan` as the UI does, times one search, prints the server's `[warmup]` lines and stops the server.
  - **`--verbose`:** stamps `make dev`'s output with the seconds since start.
- Before = e870d96 (M11), after = this commit. Same WSL2 laptop, same afternoon:

  | Measure | Target | Before | After |
  |---|---|---|---|
  | Paging, 3 runs (n = 411): p50 / p95 / max | p95 < 100 ms | 18 / 26 / 70 ms | 17 / 25 / 39 ms |
  | New search end to end, 3 runs (n = 60): p50 / p95 / max | p95 < 2.5 s | 1,759 / 2,092 / 2,206 ms | 1,738 / 2,209 / 2,273 ms |
  | First search after `make dev`, model caches warm, after 5 s | < 3 s | 2,440 / 2,156 / 1,911 ms | 2,347 / 1,596 / 1,390 ms |
  | First search after `make dev`, model caches cold, after 5 s | < 3 s | 3,729 / 3,766 / 3,228 ms (no warm-up) | 2,225 / 2,223 / 2,168 ms (server warm-up) |
  | First search after `make dev`, model caches cold, sent at once | < 3 s | not measured | 3,191 / 2,815 ms with the server's warm-up only; **2,185 / 1,924 / 2,006 ms** with `make dev`'s as well |
  | Model call whose first attempt hangs | | 9.6–10.3 s | 2.9–3.6 s (hedge measured at 1.8 s) |

  - **The cold rows** come from a temporary build (not committed): a per-start nonce in the prompt plus an extra enum value in the schema, so every start meets cold caches. Their "before" column already had the grounding-check fix, which saves another ~200 ms on top.
  - **Steady-state new search is the model,** the same within noise. Temporary timing logs put the server's own share at 50–150 ms: reserve 8–43 ms, postprocess 1–11 ms, complete 15–148 ms. p95 stayed under 2.5 s, so the smaller-output schema held in reserve wasn't needed and the parser's schema is unchanged.
  - **The model is slower today than in M6–M7** (eval parse p50 ~1.7 s vs 1.19 s). So `npm run eval` fails its own `parse p95 < 2000 ms` gate today, both on this commit (2,296 and 2,035 ms) and on e870d96 run back to back in a git worktree (2,083 ms). Every accuracy gate passes on both: queries.json 10/10 at P = R = 1, extra.json F1 1.00, hostile 15/15, no rows changed.
- Alternatives: paging numbers from the e2e suite alone (it already asserts p95 < 100 ms; the bench adds new-search and first-search numbers); measuring against `next dev` (first-hit compiles would distort everything).
- Outcome (M13): the eval's parse gate is now p95 < 2.5 s (the next entry).

### 2026-10-09: `npm run eval`'s parse gate is p95 < 2.5 s, not 2 s (M13)
- Why: the 2 s gate dates from M6, when parse p95 was 1.94 s. Since then the model has answered more slowly with nothing changed on our side. In M12 the gate failed on that commit (2,296 and 2,035 ms) and on e870d96 run back to back (2,083 ms), while every accuracy gate passed. A gate that fails on a slow day whatever the change teaches people to ignore it. 2.5 s is the plan's p95 target for a whole new search (PLAN.md § 3.10), 0.5 s under the brief's 3 s. The server's own share is 50–150 ms (M12), and `npm run bench` still checks end to end. The summary line now labels calls over 2 s as "hedge sent", because `HEDGE_AFTER_MS` is the same 2 s.
  - **The M13 run** (prompt v4, 44 model calls): parse p50 1,786 ms, p95 2,303 ms, max 2,497 ms; 7 calls over 2 s, none over 3 s. queries.json 10/10 at P = R = 1, extra.json F1 1.00, hostile 15/15, no rows changed. Every gate passes.
- Alternatives: keeping 2 s (it fails on the model's slow days, so it stops meaning anything); 3 s (the brief's limit, with no room for the server or the network); no latency gate (a growing prompt would slow every search unnoticed).

## Testing and eval

How the suites isolate their data, and what the search eval measures.

### 2026-10-08: integration tests run inside rolled-back transactions
- Why: `inRollback` wraps each test in a transaction that is always rolled back, and `sqlState` runs one statement inside a savepoint and returns its SQLSTATE. Constraint tests therefore assert the *exact* code (23514/23503/23505/23502), can't pass by accident, and leave no rows behind. `actAs` sets `request.jwt.claims` the way PostgREST does, so `auth.uid()` and the `private.current_company_id()` column defaults are exercised for real. Files run one at a time (`fileParallelism: false`) because later quota and billing tests share rows.
- Alternatives: truncating tables between tests (would fight the seeded data and the "never call make reset" rule).

### 2026-10-08: eval harness (`npm run eval`)
- Why:
  - `scripts/eval.ts` runs the real pipeline and scores result sets, not filters. queries.json uses its `expected_ids`. extra.json uses `match_candidates(gold filters)`, which M4 checked against the TypeScript oracle.
  - Rows marked `"expect": "subset"` (the Spanish brief) pass when every result is right, zero results included. They are left out of the macro F1 and gated on "never a wrong person".
  - Hostile rows check status (400 before the model when the brief is invalid), never everyone, the expectation (empty, or a subset of what the legitimate part asks for), no system-prompt text, and unchanged row counts in 12 tables.
  - One warm-up call is reported on its own (2.2–4.0 s: schema compile and cache write after a change), so the percentiles describe steady-state searches.
  - It reads `.env.local` itself with `process.loadEnvFile` and prints no key; the main error handler prints only error names and messages. It queries `private.match_candidates` over `pg` as `postgres`, like the seed and the integration tests, because it measures the pipeline rather than the API.
  - `tsx --conditions=react-server` makes `import 'server-only'` resolve to the package's empty module. The Vitest configs alias it to the same file.
- Alternatives: scoring filters field by field (equivalent filters can differ in form, e.g. `exclude.employers` vs a `never` condition); calling `complete_search` through PostgREST (each brief would spend quota and need a paid tenant).

### 2026-10-08: M6 eval results and what's left
- Why (prompt v4, 2 runs per brief):
  - **queries.json:** 10/10 at P = R = 1 in every run.
  - **extra.json:** macro F1 0.97. The one failing row is the contradiction brief "junior engineers with 15+ years of experience". The model sometimes drops "junior" and returns 322 staff with 15 years. Measured: 4/8 runs inside the eval, 10/10 in separate processes, and 7/8 at effort low vs 5/8 at medium, so higher effort doesn't fix it. A stronger rule ("never invent, never drop") and a contradiction few-shot helped ad hoc but not reliably.
  - **hostile.json:** 15/15 pass and no rows changed.
  - **Latency:** parse p50 1.19 s, p95 1.94 s; output tokens p50 192, p95 244.
  - **Zero-width characters:** "Py​thon developers" returns 0. The model reads Python, and grounding rejects it because the lexicon can't see through the zero-width space. Safe, but stripping zero-width characters in `sanitizeText` would make it work (not done: CLAUDE.md fixes what `sanitizeText` strips).
- Alternatives: chasing the contradiction brief with more prompt text (risks overfitting to one hand-written brief). A deterministic guard is proposed to Om instead.
- Outcome: the stated-level guard (approved by Om), under Search: the model call, prompt and grounding.

### 2026-10-08: M7 contract tests and measurements
- Why: `tests/e2e/contract.test.ts` (110 tests) runs against the production server (`make dev`), using throwaway companies from the integration helpers (free, burst, paid, owner and a non-recruiter user), so asterwell's and glenfold's rows are never touched. The seeded logins are only read. The expected shapes are written out in the test, separately from `lib/shared/api.ts`, so the test checks the spec rather than the implementation. Paging coverage is compared with `private.match_candidates` over `pg`: the ids must be the exact rank order, with no duplicates and the full total. Measured, three full runs on this WSL2 laptop:
  - **Paging:** a 4,676-result search, all 235 pages plus one past the end: p50 15 ms, **p95 18–19 ms**, max 21–66 ms. The test asserts p95 < 100 ms (the M12 target).
  - **New search end to end** (HTTP → auth → reserve → Haiku 5.5 → complete → page 1), 8 distinct briefs on a paid company: p50 1.13–1.27 s, **p95 1.90–2.08 s**.
  - **20 concurrent `POST /api/search` on a fresh free company:** exactly one 200 and nineteen 402s in every run. The 402s took p50 170–250 ms (queued behind each other on the usage row lock), all before the 200. That 200 was the first model call after a server start: 2.4–2.9 s, which is what the M12 warm-up targets.
  - **Mutation check:** `DELETE /api/saved-briefs/{id}` without the visibility lookup and row count returned 200 for another company's id, and the cross-company and delete tests failed. Restored afterwards.
  - Model-dependent tests use `it.skipIf(!ANTHROPIC_API_KEY)` and say so in their names. The e2e config pins Vitest's `default` reporter, because Vitest picks its agent reporter when `AI_AGENT` is set, and that reporter hides passing tests' logs (and with them the measurement lines).
- Alternatives: testing against `next dev` (first-hit compiles distort latency); testing on asterwell/glenfold (the burst needs a fresh counter, and only `make reset` restores one).

### 2026-10-14: CI on GitHub Actions
- Why: every check in CLAUDE.md § Testing rules ran only on this laptop. `.github/workflows/ci.yml` runs them on each push to `main` and on each pull request, in two jobs. `checks` (lockfile, typecheck, lint, unit) is the quick gate. `stack` runs `make setup` itself on a clean Ubuntu runner, so the contract target is exercised from scratch every time. It then runs the integration suite, starts `npm start` and runs `test:e2e` and `test:security` against it.
  - No model key is configured, so the model tests skip and say so in their names: a run costs nothing and a fork's pull request can't spend the key. The webhook uses the sample's public secret, which is only safe because this server is thrown away with the runner.
  - Actions are pinned to commit SHAs (checkout v7.0.1, setup-node v7.0.0; v7.1.0 was 6 days old), in the same spirit as exact npm pins. `permissions: contents: read` and no secrets mean a workflow change in a pull request can't publish anything.
- Alternatives: a `macos-14` arm64 runner, the contract's own platform (GitHub's macOS runners have no Docker, so `supabase start` can't run there); running the model tests with a repository secret (a real cost on every push, for checks `npm run eval` already covers before prompt changes).
