-- Free-plan quota and stored searches (PLAN.md § 3.4 steps 3, 6, 7 and § 3.5).
--
-- A new search is reserve → (LLM) → complete, or reserve → release when the model is unreachable.
-- Every function derives the company from auth.uid(); none takes a company parameter.
--
--   reserve_search   DEFINER  takes one search from the allowance (P0402 when none is left) and
--                             inserts a pending search
--   complete_search  DEFINER  ranks the matches into search_results and returns page 1
--   release_search   DEFINER  gives a pending search back (model unavailable)
--   get_search_page  INVOKER  one page of frozen ranks; never counts
--   get_plan         INVOKER  {plan, searches_remaining}
--
-- Errors: P0402 → 402, 42501 → 404 (no such search for this company), 23514 → 400 (bad input).

-- A recruiter's company, or 42501 for anyone else. Called only by the DEFINER functions below.
create function private.require_company()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
begin
  if v_company is null then
    raise exception using errcode = '42501', message = 'not a recruiter';
  end if;
  return v_company;
end
$$;
revoke all on function private.require_company() from public, anon, authenticated, service_role;

create function public.reserve_search(p_brief text, p_source text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_paid    boolean;
  v_stale   integer;
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

  insert into public.searches (company_id, recruiter_id, brief, source)
  values (v_company, auth.uid(), p_brief, p_source)
  returning id into v_id;
  return v_id;
end
$$;

-- One page of a done search of the caller's company. INVOKER, so RLS applies when a recruiter calls
-- it; the explicit company filter keeps it correct when complete_search (DEFINER) calls it too.
create function public.get_search_page(p_search_id uuid, p_page integer default 1)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_search  public.searches%rowtype;
begin
  if p_page is null or p_page < 1 or p_page > 10000 then
    raise exception using errcode = 'check_violation', message = 'page must be a whole number from 1 to 10000';
  end if;
  select * into v_search from public.searches s
  where s.id = p_search_id and s.company_id = v_company and s.status = 'done';
  if not found then
    raise exception using errcode = '42501', message = 'search not found';
  end if;

  return jsonb_build_object(
    'search_id', v_search.id,
    'brief', v_search.brief,
    'filters', v_search.filters,
    'page', p_page,
    'per_page', 20,
    'total', v_search.total,
    -- A card: the candidates.json fields a result list shows.
    'results', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', c.id,
          'full_name', c.full_name,
          'avatar_url', c.avatar_url,
          'headline', c.headline,
          'current_title', c.current_title,
          'current_company', c.current_company,
          'current_company_logo_url', c.current_company_logo_url,
          'role', c.role,
          'seniority', c.seniority,
          'years_experience', c.years_experience,
          'location', jsonb_build_object('city', c.city, 'state', c.state, 'country', c.country),
          'open_to_work', c.open_to_work,
          'skills', to_jsonb(c.skills)
        ) order by r.rank)
      from public.search_results r
      join public.candidates c on c.id = r.candidate_id
      where r.search_id = v_search.id and r.company_id = v_company
        and r.rank between (p_page - 1) * 20 + 1 and p_page * 20
    ), '[]'::jsonb)
  );
end
$$;

create function public.get_plan()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_paid    boolean;
  v_used    integer;
begin
  if v_company is null then
    raise exception using errcode = '42501', message = 'not a recruiter';
  end if;
  v_paid := exists (
    select 1 from public.subscriptions s
    where s.company_id = v_company and s.status in ('active', 'trialing'));
  v_used := coalesce((select u.searches_used from public.company_usage u where u.company_id = v_company), 0);
  -- Free: 1 search in total, so a company that searched while paid has none left after cancelling.
  return jsonb_build_object(
    'plan', case when v_paid then 'paid' else 'free' end,
    'searches_remaining', case when v_paid then null else greatest(0, 1 - v_used) end);
end
$$;

create function public.complete_search(p_search_id uuid, p_filters jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_total   integer;
begin
  -- Only the caller's own pending search; the row lock makes complete and release mutually exclusive.
  perform 1 from public.searches s
  where s.id = p_search_id and s.company_id = v_company and s.status = 'pending'
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'no pending search with that id';
  end if;

  insert into public.search_results (search_id, rank, company_id, candidate_id)
  select p_search_id, m.rank, v_company, m.candidate_id
  from private.match_candidates(p_filters) m;
  get diagnostics v_total = row_count;

  update public.searches s
  set status = 'done', filters = p_filters, total = v_total, completed_at = now()
  where s.id = p_search_id;

  return public.get_search_page(p_search_id, 1) || jsonb_build_object('searches_remaining', public.get_plan() -> 'searches_remaining');
end
$$;

create function public.release_search(p_search_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  -- Pending only: a completed search was a real search and stays counted.
  delete from public.searches s
  where s.id = p_search_id and s.company_id = v_company and s.status = 'pending';
  if not found then
    raise exception using errcode = '42501', message = 'no pending search with that id';
  end if;
  update public.company_usage u set searches_used = greatest(u.searches_used - 1, 0) where u.company_id = v_company;
end
$$;

-- Revoke first, then grant each to exactly one role (CLAUDE.md § Database rules).
revoke all on function public.reserve_search(text, text) from public, anon, authenticated, service_role;
revoke all on function public.complete_search(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.release_search(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_search_page(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_plan() from public, anon, authenticated, service_role;

grant execute on function public.reserve_search(text, text) to authenticated;
grant execute on function public.complete_search(uuid, jsonb) to authenticated;
grant execute on function public.release_search(uuid) to authenticated;
grant execute on function public.get_search_page(uuid, integer) to authenticated;
grant execute on function public.get_plan() to authenticated;
