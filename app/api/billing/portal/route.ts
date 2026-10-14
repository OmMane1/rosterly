import { requireRecruiter } from '@/lib/server/auth';
import { createPortal } from '@/lib/server/billing/checkout';
import { handler, json } from '@/lib/server/http';

// The Stripe SDK runs on Node.
export const runtime = 'nodejs';

export const POST = handler(async (req: Request) => {
  const recruiter = await requireRecruiter(req);
  return json(await createPortal(recruiter, new URL(req.url).origin));
});
