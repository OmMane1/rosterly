import { requireRecruiter } from '@/lib/server/auth';
import { handler, json, uuidParam } from '@/lib/server/http';
import { broaderOptions } from '@/lib/server/search-service';

export const GET = handler(async (req: Request, ctx: RouteContext<'/api/search/[search_id]/broader'>) => {
  const recruiter = await requireRecruiter(req);
  const id = uuidParam((await ctx.params).search_id, 'Search');
  return json(await broaderOptions(recruiter, id));
});
