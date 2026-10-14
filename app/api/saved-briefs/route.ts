import { SavedBriefRequest } from '@/lib/shared/api';
import { requireRecruiter } from '@/lib/server/auth';
import { handler, json, parseInput, readJsonObject } from '@/lib/server/http';
import { createSavedBrief, listSavedBriefs } from '@/lib/server/saved-briefs';

export const GET = handler(async (req: Request) => {
  const recruiter = await requireRecruiter(req);
  return json(await listSavedBriefs(recruiter));
});

export const POST = handler(async (req: Request) => {
  const recruiter = await requireRecruiter(req);
  const input = parseInput(SavedBriefRequest, await readJsonObject(req), 'invalid_request');
  return json(await createSavedBrief(recruiter, input));
});
