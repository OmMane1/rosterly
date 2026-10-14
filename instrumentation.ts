// Next calls register() once per server start and waits for it before serving requests (it skips
// it during `next build`). The model warm-up is started here and never awaited, so start-up time is
// unchanged and a failed warm-up can't stop the server (PLAN.md M12).
export function register(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  void import('@/lib/server/search/warmup').then(({ warmUp }) => warmUp()).catch(() => console.warn('[warmup] skipped: it could not be loaded'));
}
