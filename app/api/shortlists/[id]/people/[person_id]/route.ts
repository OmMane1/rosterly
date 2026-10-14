import { requireRecruiter } from '@/lib/server/auth';
import { handler, json } from '@/lib/server/http';
import { addPerson, removePerson } from '@/lib/server/shortlists';

type Ctx = RouteContext<'/api/shortlists/[id]/people/[person_id]'>;

export const POST = handler(async (req: Request, ctx: Ctx) => {
  const recruiter = await requireRecruiter(req);
  const { id, person_id } = await ctx.params;
  return json(await addPerson(recruiter, id, person_id));
});

export const DELETE = handler(async (req: Request, ctx: Ctx) => {
  const recruiter = await requireRecruiter(req);
  const { id, person_id } = await ctx.params;
  return json(await removePerson(recruiter, id, person_id));
});
