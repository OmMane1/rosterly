import { ShortlistRequest } from '@/lib/shared/api';
import { requireRecruiter } from '@/lib/server/auth';
import { handler, json, parseInput, readJsonObject } from '@/lib/server/http';
import { createShortlist, listShortlists } from '@/lib/server/shortlists';

export const GET = handler(async (req: Request) => {
  const recruiter = await requireRecruiter(req);
  return json(await listShortlists(recruiter));
});

export const POST = handler(async (req: Request) => {
  const recruiter = await requireRecruiter(req);
  const { name } = parseInput(ShortlistRequest, await readJsonObject(req), 'invalid_name');
  return json(await createShortlist(recruiter, name));
});
