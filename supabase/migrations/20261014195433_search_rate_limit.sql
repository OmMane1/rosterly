-- Per-recruiter search pace (DECISIONS.md "A per-recruiter search rate limit in reserve_search").
-- On the paid plan nothing else bounds how fast one login can start searches, and each one can
-- cost a model call and up to 5,000 search_results rows. reserve_search now refuses a recruiter's
-- 21st search within a minute, or 101st within an hour, with P0429 (→ 429).
--
-- The check runs after the company_usage UPDATE, whose row lock serialises a company's concurrent
-- reservations. Under READ COMMITTED the count then sees every search committed before the lock was
-- granted, so a burst gets exactly the limit and no more. A refusal rolls the increment back with
-- the rest of the call. The 402 comes first: on the free plan the limit never matters.

create index searches_recruiter_created_idx on public.searches (recruiter_id, created_at desc);

create or replace function public.reserve_search(p_brief text, p_source text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_paid    boolean;
  v_stale   integer;
  v_minute  integer;
  v_hour    integer;
  v_id      uuid;
begin
  -- A reservation left pending for 2 minutes belongs to a request that died (the LLM call times out
  -- after seconds), so it is handed back first: a crash can't eat the free search.
  delete from public.searches s
  where s.company_id = v_company and s.status = 'pending' and s.created_at < now() - interval '2 minutes';
  get diagnostics v_stale = row_count;
  if v_stale > 0 then
    update public.company_usage u set searches_used = greatest(u.searches_used - v_stale, 0) where u.company_id = v_company;
  end if;

  v_paid := exists (
    select 1 from public.subscriptions s
    where s.company_id = v_company and s.status in ('active', 'trialing'));

  -- One conditional UPDATE: its row lock serialises concurrent callers, and READ COMMITTED re-checks
  -- the condition against the winner's committed row, so exactly one free search is ever handed out.
  -- The free allowance is 1 search in total (also in get_plan).
  update public.company_usage u set searches_used = u.searches_used + 1
  where u.company_id = v_company and (v_paid or u.searches_used < 1);
  if not found then
    raise exception using errcode = 'P0402', message = 'The free plan includes 1 search, and it has been used.';
  end if;

  select count(*) filter (where s.created_at > now() - interval '1 minute'), count(*)
  into v_minute, v_hour
  from public.searches s
  where s.recruiter_id = auth.uid() and s.created_at > now() - interval '1 hour';
  if v_minute >= 20 or v_hour >= 100 then
    raise exception using errcode = 'P0429', message = 'Too many searches from this account: at most 20 a minute and 100 an hour.';
  end if;

  insert into public.searches (company_id, recruiter_id, brief, source)
  values (v_company, auth.uid(), p_brief, p_source)
  returning id into v_id;
  return v_id;
end
$$;

-- `create or replace` keeps the grants; restated so this file alone shows who may call it.
revoke all on function public.reserve_search(text, text) from public, anon, authenticated, service_role;
grant execute on function public.reserve_search(text, text) to authenticated;
