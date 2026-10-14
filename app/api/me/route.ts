import { requireRecruiter } from '@/lib/server/auth';
import { handler, json } from '@/lib/server/http';
import { getMe } from '@/lib/server/me';

export const GET = handler(async (req: Request) => {
  const recruiter = await requireRecruiter(req);
  return json(await getMe(recruiter));
});
