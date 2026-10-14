import { requireRecruiter } from '@/lib/server/auth';
import { handler, json } from '@/lib/server/http';
import { getPerson } from '@/lib/server/people';

export const GET = handler(async (req: Request, ctx: RouteContext<'/api/people/[id]'>) => {
  const recruiter = await requireRecruiter(req);
  return json(await getPerson(recruiter, (await ctx.params).id));
});
