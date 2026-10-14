import 'server-only';
// The signed-in recruiter and their company, read as the recruiter (RLS: own company only).
import { Me } from '@/lib/shared/api';
import type { Recruiter } from './auth';
import { check } from './supabase';

export async function getMe(r: Recruiter): Promise<Me> {
  const company = check(await r.db.from('companies').select('slug,name').eq('id', r.companyId).single());
  return Me.parse({ email: r.email, company });
}
