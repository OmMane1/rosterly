# Contract targets (CLAUDE.md § Output contract). Recipes only call npm and Node scripts, so the
# GNU Make 3.81 that ships with macOS runs this file unchanged.

# The Supabase CLI prints the local keys on stdout (`start` ends with the stack's status), so every
# call goes through scripts/supabase-quiet.mjs: the output lands in .logs/supabase.log (git-ignored)
# and the terminal gets only the progress lines. It runs node_modules/.bin/supabase, the pinned CLI.
SUPABASE = node scripts/supabase-quiet.mjs
export NEXT_TELEMETRY_DISABLED = 1

.PHONY: setup dev reset

setup:
	@node scripts/check-env.mjs setup
	npm ci
	@node scripts/check-env.mjs cli
	@$(SUPABASE) start
	@$(SUPABASE) migration up --local
	@node scripts/write-env.mjs
	npm run seed
	npm run build

# The model warm-up runs in the background while Supabase starts, so the first search finds the
# model's caches warm (scripts/warmup.ts). It never blocks or fails the target.
dev:
	@node_modules/.bin/tsx --conditions=react-server scripts/warmup.ts &
	@node scripts/check-env.mjs dev
	@$(SUPABASE) start
	@node scripts/write-env.mjs
	@node scripts/build-if-stale.mjs
	npm start

reset:
	@$(SUPABASE) db reset --local
	@node scripts/write-env.mjs
	npm run seed
