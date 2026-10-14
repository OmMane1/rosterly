import { requireRecruiter } from '@/lib/server/auth';
import { handler, json, pageParam, uuidParam } from '@/lib/server/http';
import { searchPage } from '@/lib/server/search-service';

export const GET = handler(async (req: Request, ctx: RouteContext<'/api/search/[search_id]'>) => {
  const recruiter = await requireRecruiter(req);
  const page = pageParam(req);
  const id = uuidParam((await ctx.params).search_id, 'Search');
  return json(await searchPage(recruiter, id, page));
});
