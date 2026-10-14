-- match_candidates: filter candidates on their own columns first (DECISIONS.md: "match_candidates speed").
--
-- The set-based version judged experience conditions over every job in the table, even when a role
-- or city had already narrowed the candidates to a few hundred: a 21-row brief took 25 ms. Now the
-- candidate-level filters run first (`base`), experience and education checks only look at those
-- candidates, and the per-condition grouping uses a byte-order key. Same semantics.

create or replace function private.match_candidates(filters jsonb)
returns table (candidate_id text, rank integer)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_roles        text[];
  v_seniority    text[];
  v_cities       text[];
  v_states       text[];
  v_skills_all   text[];
  v_skills_any   text[];
  v_requested    text[];
  v_open         boolean;
  v_years_min    integer;
  v_years_max    integer;
  v_experience   jsonb;
  v_positive     integer;
  v_schools      text[];
  v_degrees      text[];
  v_fields       text[];
  v_grad_min     integer;
  v_grad_max     integer;
  v_exclude      jsonb;
  x_roles        text[];
  x_cities       text[];
  x_states       text[];
  x_skills       text[];
  x_schools      text[];
  x_degrees      text[];
  x_employers    text[];
  v_unsupported  jsonb;
begin
  if filters is null or jsonb_typeof(filters) <> 'object' then
    raise exception using errcode = 'check_violation', message = 'filters must be a JSON object';
  end if;

  v_roles      := private.filter_list(filters, 'roles');
  v_seniority  := private.filter_list(filters, 'seniority');
  v_cities     := private.filter_list(filters, 'cities');
  v_states     := private.filter_list(filters, 'states');
  v_skills_all := private.filter_list(filters, 'skills_all');
  v_skills_any := private.filter_list(filters, 'skills_any');
  v_open       := private.filter_bool(filters, 'open_to_work');
  v_years_min  := private.filter_int(filters, 'years_min', 0, 99);
  v_years_max  := private.filter_int(filters, 'years_max', 0, 99);
  v_experience := private.filter_experience(filters);
  v_schools    := private.filter_list(filters, 'schools');
  v_degrees    := private.filter_list(filters, 'degrees');
  v_fields     := private.filter_list(filters, 'fields');
  v_grad_min   := private.filter_int(filters, 'graduated_min', 1900, 2100);
  v_grad_max   := private.filter_int(filters, 'graduated_max', 1900, 2100);

  v_exclude := filters -> 'exclude';
  if v_exclude is not null and jsonb_typeof(v_exclude) not in ('object', 'null') then
    raise exception using errcode = 'check_violation', message = 'filters: exclude must be an object';
  end if;
  x_roles     := private.filter_list(v_exclude, 'roles');
  x_cities    := private.filter_list(v_exclude, 'cities');
  x_states    := private.filter_list(v_exclude, 'states');
  x_skills    := private.filter_list(v_exclude, 'skills');
  x_schools   := private.filter_list(v_exclude, 'schools');
  x_degrees   := private.filter_list(v_exclude, 'degrees');
  x_employers := private.filter_list(v_exclude, 'employers');

  v_unsupported := filters -> 'unsupported';
  if v_unsupported is not null and jsonb_typeof(v_unsupported) not in ('array', 'null') then
    raise exception using errcode = 'check_violation', message = 'filters: unsupported must be a list';
  end if;

  -- Policy rule 1: one unanswerable constraint empties the answer.
  if jsonb_typeof(v_unsupported) = 'array' and jsonb_array_length(v_unsupported) > 0 then
    return;
  end if;
  -- Policy rule 6: no supported constraint left → nothing, never everyone.
  if coalesce(v_roles, v_seniority, v_cities, v_states, v_skills_all, v_skills_any, v_schools, v_degrees, v_fields) is null
     and v_open is null and v_years_min is null and v_years_max is null
     and v_grad_min is null and v_grad_max is null and v_experience is null then
    return;
  end if;

  if v_skills_any is not null then
    v_skills_any := array(select distinct s from unnest(v_skills_any) s);
  end if;
  v_requested := array(select distinct s from unnest(coalesce(v_skills_all, '{}') || coalesce(v_skills_any, '{}')) s);
  v_positive := (select count(*) from jsonb_array_elements(v_experience) x where x ->> 'when' <> 'never');

  return query
  with conds as materialized (
    select k.ord, k.x ->> 'when' as w, k.x ->> 'company_type' as ct, private.filter_list(k.x, 'employers') as emps
    from jsonb_array_elements(v_experience) with ordinality as k(x, ord)
  ),
  -- Candidates passing every filter on their own columns: the cheap part, done first, so the
  -- experience and education checks below only look at these.
  base as materialized (
    select c.id, c.open_to_work, c.years_experience, c.skills
    from public.candidates c
    where (v_roles is null or c.role = any(v_roles))
      and (v_seniority is null or c.seniority = any(v_seniority))
      and ((v_cities is null and v_states is null)
           or c.city = any(coalesce(v_cities, '{}')) or c.state = any(coalesce(v_states, '{}')))
      and (v_skills_all is null or c.skills @> v_skills_all)
      and (v_skills_any is null or c.skills && v_skills_any)
      and (v_open is null or c.open_to_work = v_open)
      and (v_years_min is null or c.years_experience >= v_years_min)
      and (v_years_max is null or c.years_experience <= v_years_max)
      and (x_roles is null or c.role <> all(x_roles))
      and (x_cities is null or c.city <> all(x_cities))
      and (x_states is null or c.state <> all(x_states))
      and (x_skills is null or not c.skills && x_skills)
  ),
  -- One row per (candidate, condition) that some job of theirs matches: is that job current, or
  -- ended? Grouped on a byte-order key: the database collation's strcoll doubled the cost.
  hits as materialized (
    select e.candidate_id collate "C" as candidate_id, k.ord, k.w collate "C" as w,
           bool_or(e.end_year is null) as now, bool_or(e.end_year is not null) as before
    from base b
    join public.candidate_experiences e on e.candidate_id = b.id
    join conds k on (k.ct is null or e.company_type = k.ct) and (k.emps is null or e.company = any(k.emps))
    where v_experience is not null
    group by e.candidate_id collate "C", k.ord, k.w collate "C"
  ),
  -- any = some job matches; current = the current job does; past = an ended one does and the current
  -- one doesn't; never = none does. A candidate passes when every non-never condition holds and no
  -- never condition has a hit.
  experience_pass as (
    select h.candidate_id
    from hits h
    group by h.candidate_id
    having count(*) filter (where h.w = 'any' or (h.w = 'current' and h.now) or (h.w = 'past' and h.before and not h.now)) = v_positive
       and count(*) filter (where h.w = 'never') = 0
  ),
  matched as (
    select
      b.id,
      b.open_to_work,
      b.years_experience,
      -- Ranking signals (PLAN.md § 3.4), computed for matches only and skipped when not asked for.
      case when v_skills_any is null then 0
           else (select count(*) from unnest(v_skills_any) s where s = any(b.skills)) end as any_hits,
      case when cardinality(v_requested) = 0 then 0
           else (select count(*) from unnest(v_requested) s
                 where s = any(b.skills) and private.mentions(cur.description, s)) end as focus_hits,
      case when v_positive = 0 then 0
           else (select count(*) from conds k
                 where k.w in ('any', 'current')
                   and (k.ct is null or cur.company_type = k.ct) and (k.emps is null or cur.company = any(k.emps))) end as current_hits
    from base b
    -- The current job is read only by the ranking signals that need it.
    left join public.candidate_experiences cur
      on cur.candidate_id = b.id and cur.end_year is null and (cardinality(v_requested) > 0 or v_positive > 0)
    where (v_experience is null
           or (v_positive > 0 and b.id in (select p.candidate_id from experience_pass p))
           or (v_positive = 0 and b.id not in (select h.candidate_id from hits h)))
      -- School, degree, field and graduation year on the same education row.
      and ((v_schools is null and v_degrees is null and v_fields is null and v_grad_min is null and v_grad_max is null)
           or exists (
             select 1 from public.candidate_education d
             where d.candidate_id = b.id
               and (v_schools is null or d.school = any(v_schools))
               and (v_degrees is null or d.degree = any(v_degrees))
               and (v_fields is null or d.field = any(v_fields))
               and (v_grad_min is null or d.graduation_year >= v_grad_min)
               and (v_grad_max is null or d.graduation_year <= v_grad_max)))
      and ((x_schools is null and x_degrees is null)
           or not exists (
             select 1 from public.candidate_education d
             where d.candidate_id = b.id
               and (d.school = any(coalesce(x_schools, '{}')) or d.degree = any(coalesce(x_degrees, '{}')))))
      and (x_employers is null
           or not exists (select 1 from public.candidate_experiences e where e.candidate_id = b.id and e.company = any(x_employers)))
  ),
  ranked as (
    select
      m.id,
      row_number() over (
        order by m.any_hits desc, m.focus_hits desc, m.current_hits desc, m.open_to_work desc,
                 m.years_experience desc, m.id collate "C"
      ) as rank,
      count(*) over () as matched
    from matched m
  )
  -- Policy rule 4: if the constraints match everyone, none of them narrowed anything.
  select r.id, r.rank::integer
  from ranked r
  where r.matched < (select count(*) from public.candidates)
  order by r.rank;
end
$$;
revoke all on function private.match_candidates(jsonb) from public, anon, authenticated, service_role;
