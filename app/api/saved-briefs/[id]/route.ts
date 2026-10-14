import { requireRecruiter } from '@/lib/server/auth';
import { handler, json } from '@/lib/server/http';
import { deleteSavedBrief } from '@/lib/server/saved-briefs';

export const DELETE = handler(async (req: Request, ctx: RouteContext<'/api/saved-briefs/[id]'>) => {
  const recruiter = await requireRecruiter(req);
  return json(await deleteSavedBrief(recruiter, (await ctx.params).id));
});
