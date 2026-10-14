import { SearchRequest } from '@/lib/shared/api';
import { requireRecruiter } from '@/lib/server/auth';
import { handler, json, parseInput, readJsonObject } from '@/lib/server/http';
import { newSearch } from '@/lib/server/search-service';

export const POST = handler(async (req: Request) => {
  const recruiter = await requireRecruiter(req);
  const { brief } = parseInput(SearchRequest, await readJsonObject(req), 'invalid_brief');
  return json(await newSearch(recruiter, brief));
});
