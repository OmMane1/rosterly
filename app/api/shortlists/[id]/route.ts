import { ShortlistRequest } from '@/lib/shared/api';
import { requireRecruiter } from '@/lib/server/auth';
import { handler, json, parseInput, readJsonObject } from '@/lib/server/http';
import { deleteShortlist, getShortlist, renameShortlist } from '@/lib/server/shortlists';

type Ctx = RouteContext<'/api/shortlists/[id]'>;

export const GET = handler(async (req: Request, ctx: Ctx) => {
  const recruiter = await requireRecruiter(req);
  return json(await getShortlist(recruiter, (await ctx.params).id));
});

export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const recruiter = await requireRecruiter(req);
  const { name } = parseInput(ShortlistRequest, await readJsonObject(req), 'invalid_name');
  return json(await renameShortlist(recruiter, (await ctx.params).id, name));
});

export const DELETE = handler(async (req: Request, ctx: Ctx) => {
  const recruiter = await requireRecruiter(req);
  return json(await deleteShortlist(recruiter, (await ctx.params).id));
});
