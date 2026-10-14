// Browser configuration. Only NEXT_PUBLIC_* names appear in this file (CLAUDE.md § Security rules),
// so not even the name of a secret ships to the browser. Next inlines the value at build time.
export function publishableKey(): string {
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!key) throw new Error('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set. Run `make setup`.');
  return key;
}
