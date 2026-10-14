import 'server-only';
// The company's plan, from the one formula in get_plan() (PLAN.md § 3.5), so /api/plan, the search
// responses and the 402 body always agree.
import { Plan } from '@/lib/shared/api';
import type { Recruiter } from './auth';
import { check } from './supabase';

export async function getPlan(r: Recruiter): Promise<Plan> {
  return Plan.parse(check(await r.db.rpc('get_plan')));
}
