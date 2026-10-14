import { requireRecruiter } from '@/lib/server/auth';
import { handler, json } from '@/lib/server/http';
import { getPlan } from '@/lib/server/plan';

export const GET = handler(async (req: Request) => {
  const recruiter = await requireRecruiter(req);
  return json(await getPlan(recruiter));
});
