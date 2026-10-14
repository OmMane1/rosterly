# Rosterly

Recruiter search in plain English. A recruiter describes who they want ("senior Go engineers in Seattle"), Claude turns the brief into filters, and Postgres finds and ranks the people. Every filter shows as a chip the recruiter can correct. Recruiters can open profiles, shortlist people and save searches. Companies are isolated by row-level security, the free plan includes one search, and upgrades arrive only as signed Stripe webhooks.

Next.js 16, Supabase (Postgres, Auth, RLS), Claude Haiku 5.5, Stripe webhooks, Tailwind and shadcn/ui. The 5,000 candidates are a **synthetic dataset** made by `scripts/gen-dataset.ts`: every person, employer, avatar and logo is invented. Code: UI in `app/(app)` and `components`, routes in `app/api`, logic in `lib/server`, schema in `supabase/migrations`.

## Run it

With Node 24 and Docker running, export `ANTHROPIC_API_KEY` and `STRIPE_WEBHOOK_SECRET` (or put them in `.env.local`; an exported value wins). Then `make setup` (~2 min plus image pulls) and `make dev` (http://localhost:3000). Sign in as `recruiter@asterwell.test` or `recruiter@glenfold.test` with `rosterly-demo`. `make reset` reseeds. With `STRIPE_WEBHOOK_SECRET=whsec_rosterly_sample` (the sample's public secret), `npm run replay:stripe` replays the sample webhook events; `-- --resign` signs them with your own secret instead.

Tests: `npm test` and `npm run test:integration`. With `make dev` running: `npm run test:e2e`, `test:security`, `test:ui`, `eval` and `bench`. `npm run gen:data && npm run gen:vocab` regenerates the dataset.

## How search works

1. One conditional `UPDATE` reserves the search; with none left, a 402 comes back before any model call.
2. Claude Haiku 5.5 answers in JSON fitting a schema generated from the data, where every role, skill, city, employer and school is an enum.
3. The server re-validates and grounds the filters (below).
4. Static SQL finds the exact set and ranks it by skills matched, skills used in the current job, open to work, years, then id. The ranks are stored.
5. Paging reads the stored ranks: free, stable, complete, p95 35 ms.

Every filter shows as a chip, and editing one re-runs the SQL without the model.

## Stopping the model inventing filters

- **Only real values.** There is no enum slot for "London" or "Elixir".
- **What can't be expressed is declared.** Language, salary, remote work, a security clearance, an unknown city or "principal" goes into `unsupported`. Any entry gives 0 results and a removable chip with the reason: nobody beats the wrong people.
- **Grounding.** A city, state, employer, school or skill the brief doesn't mention moves to `unsupported`, which catches forced guesses like London → New York.
- **Fixed rules for vague words.** Puffery ("rockstar") is ignored. A small mapping table, each row checked against the data, covers the rest ("experienced" → 6+ years).
- **Never everyone.** No real filter means 0 results, in TypeScript and in SQL. The brief is sent JSON-encoded in `<brief>` tags, and no SQL is built from text.

`npm run eval`: precision = recall = 1 on the 10 held-out briefs (their answer key comes from plain predicates in the generator, not from the search SQL), F1 1.00 on 21 trap briefs, and 15/15 hostile briefs pass with no data changed.

## Model and cost

**Claude Haiku 5.5** (`claude-haiku-5-5`), thinking off, effort low. Closed-vocabulary extraction is a small-model job: Haiku scores perfectly on the eval sets, and Sonnet 5.5 would cost 20× more. Parse p50 is 1.8 s, p95 2.4 s; a whole new search is p95 2.0 s end to end.

Per search (mean of 44 calls): 8,968 cached prompt tokens read ($0.000090), 46 uncached in ($0.000005), 201 out ($0.000101), so **$0.00020**. The hedge (a duplicate request if the first is pending after 2 s) fired 4 times; billing those in full gives **≈ $0.00021**, about 4,700 searches per dollar. Rewriting the 1-hour prompt cache costs ~$0.002, which `make dev`'s warm-up pays.

## Tradeoffs

- **Exact sets, not fuzzy scores.** One unanswerable constraint empties the result until its chip is removed.
- **Every new result set counts** on Free, even a chip edit or zero results: the plan limits searches, not successful ones, and refunding empty results would let anyone probe for free. Only a model outage refunds one.
- **Searches made while paid still count.** The free plan is 1 search in total, so a company that cancels has none left.
- **Frozen ranks.** Paging is a primary-key scan, paid for by one insert of up to 5k rows per search (≤ 110 ms).
- **Webhook signatures of any age**, since the sample is signed ahead of time; event-id idempotency and ordering by (created, type, id) make repeats and stale events harmless.
- **`invoice.*` is ignored.** `invoice.paid` can arrive after a cancellation and would wrongly reactivate the company.
- **`make dev` serves a production build**, so no request waits for a compile.
- **The hedge** costs up to 16% more tokens and cuts a stalled call from ~10 s to under 4 s.

## What's next

- When a search returns 0, offer the nearest broader search (drop one filter) with live counts.
- Per-recruiter rate limiting and an audit log.
- CI on a `macos-14` arm64 runner.
- Random filter sets checked against the TypeScript oracle, and a synthetic eval with many phrasings per brief.
