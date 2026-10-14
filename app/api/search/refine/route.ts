import { RefineRequest } from '@/lib/shared/api';
import { requireRecruiter } from '@/lib/server/auth';
import { handler, json, parseInput, readJsonObject } from '@/lib/server/http';
import { refineSearch } from '@/lib/server/search-service';

export const POST = handler(async (req: Request) => {
  const recruiter = await requireRecruiter(req);
  const input = parseInput(RefineRequest, await readJsonObject(req), 'invalid_request');
  return json(await refineSearch(recruiter, input));
});
