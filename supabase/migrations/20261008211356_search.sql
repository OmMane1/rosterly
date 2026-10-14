-- Candidate matching (PLAN.md § 3.4): exact set, useful order, static SQL only.
--
-- The filters arrive as one jsonb value. Each field is checked and read into a typed variable, and a
-- single fixed query uses those variables with null guards, so no text from a brief or from the
-- model ever becomes SQL. Everything lives in `private` (not exposed by PostgREST) and is granted to
-- nobody: complete_search (M5, SECURITY DEFINER) is the only caller besides the owner.

-- A malformed filters value is the caller's fault: check_violation (23514) maps to 400.
create function private.filter_list(obj jsonb, key text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := obj -> key;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 50
     or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string') then
    raise exception using errcode = 'check_violation', message = 'filters: ' || key || ' must be a list of at most 50 strings';
  end if;
  -- An empty list is no constraint, the same as an absent one.
  if jsonb_array_length(v) = 0 then
    return null;
  end if;
  return array(select jsonb_array_elements_text(v));
end
$$;

create function private.filter_int(obj jsonb, key text, lo integer, hi integer)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := obj -> key;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'number' or v::numeric <> trunc(v::numeric) or v::numeric not between lo and hi then
    raise exception using errcode = 'check_violation', message = 'filters: ' || key || ' must be a whole number from ' || lo || ' to ' || hi;
  end if;
  return v::numeric::integer;
end
$$;

create function private.filter_bool(obj jsonb, key text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := obj -> key;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'boolean' then
    raise exception using errcode = 'check_violation', message = 'filters: ' || key || ' must be true or false';
  end if;
  return v::boolean;
end
$$;

-- The experience conditions, checked, or null when there are none.
create function private.filter_experience(obj jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := obj -> 'experience';
  cond jsonb;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 10 then
    raise exception using errcode = 'check_violation', message = 'filters: experience must be a list of at most 10 conditions';
  end if;
  for cond in select e from jsonb_array_elements(v) e loop
    if jsonb_typeof(cond) <> 'object'
       or coalesce(cond ->> 'when', '') not in ('any', 'current', 'past', 'never')
       or (cond ? 'company_type' and jsonb_typeof(cond -> 'company_type') not in ('string', 'null')) then
      raise exception using errcode = 'check_violation', message = 'filters: each experience condition needs when = any|current|past|never';
    end if;
    -- A condition with no company type and no employer would match every job (or none).
    if cond ->> 'company_type' is null and private.filter_list(cond, 'employers') is null then
      raise exception using errcode = 'check_violation', message = 'filters: an experience condition needs a company type or an employer';
    end if;
  end loop;
  return case when jsonb_array_length(v) = 0 then null else v end;
end
$$;

-- Does one job satisfy a condition's company_type and employers? A plain expression, so it inlines.
create function private.job_matches(company text, company_type text, cond jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (cond ->> 'company_type' is null or company_type = cond ->> 'company_type')
     and (coalesce(jsonb_array_length(cond -> 'employers'), 0) = 0 or cond -> 'employers' ? company)
$$;

-- Whole-word, case-sensitive mention of a literal (every non-alphanumeric character is escaped, so
-- the needle can never act as a pattern). "Go" doesn't match "Google"; "R" doesn't match "React".
create function private.mentions(haystack text, needle text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select haystack ~ ('(^|[^[:alnum:]])' || regexp_replace(needle, '([^[:alnum:][:space:]])', '\\\1', 'g') || '($|[^[:alnum:]])')
$$;

-- Ranked ids of every candidate matching `filters` (the canonical Filters of lib/shared/filters.ts).
-- Returns nothing when an unsupported item is present (policy rule 1), when no substantive
-- constraint is left (rule 6), or when the constraints match everyone (rule 4: then none of them
-- narrowed anything, so none is a real filter). Nothing ever returns all candidates.
create function private.match_candidates(filters jsonb)
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

  if jsonb_typeof(v_unsupported) = 'array' and jsonb_array_length(v_unsupported) > 0 then
    return;
  end if;
  if coalesce(v_roles, v_seniority, v_cities, v_states, v_skills_all, v_skills_any, v_schools, v_degrees, v_fields) is null
     and v_open is null and v_years_min is null and v_years_max is null
     and v_grad_min is null and v_grad_max is null and v_experience is null then
    return;
  end if;

  v_requested := array(select distinct s from unnest(coalesce(v_skills_all, '{}') || coalesce(v_skills_any, '{}')) s);

  return query
  with matched as (
    select
      c.id,
      c.open_to_work,
      c.years_experience,
      -- Ranking signals (PLAN.md § 3.4), computed for matches only.
      coalesce(cardinality(array(select unnest(c.skills) intersect select unnest(v_skills_any))), 0) as any_hits,
      (select count(*) from unnest(v_requested) s
        where s = any(c.skills) and private.mentions(cur.description, s)) as focus_hits,
      (select count(*) from jsonb_array_elements(v_experience) cond(x)
        where cond.x ->> 'when' in ('any', 'current') and private.job_matches(cur.company, cur.company_type, cond.x)) as current_hits
    from public.candidates c
    left join public.candidate_experiences cur on cur.candidate_id = c.id and cur.end_year is null
    where (v_roles is null or c.role = any(v_roles))
      and (v_seniority is null or c.seniority = any(v_seniority))
      and ((v_cities is null and v_states is null)
           or c.city = any(coalesce(v_cities, '{}')) or c.state = any(coalesce(v_states, '{}')))
      and (v_skills_all is null or c.skills @> v_skills_all)
      and (v_skills_any is null or c.skills && v_skills_any)
      and (v_open is null or c.open_to_work = v_open)
      and (v_years_min is null or c.years_experience >= v_years_min)
      and (v_years_max is null or c.years_experience <= v_years_max)
      -- Every experience condition holds.
      and not exists (
        select 1 from jsonb_array_elements(v_experience) cond(x)
        where not case cond.x ->> 'when'
          when 'current' then exists (
            select 1 from public.candidate_experiences e
            where e.candidate_id = c.id and e.end_year is null and private.job_matches(e.company, e.company_type, cond.x))
          when 'past' then exists (
              select 1 from public.candidate_experiences e
              where e.candidate_id = c.id and e.end_year is not null and private.job_matches(e.company, e.company_type, cond.x))
            and not exists (
              select 1 from public.candidate_experiences e
              where e.candidate_id = c.id and e.end_year is null and private.job_matches(e.company, e.company_type, cond.x))
          when 'never' then not exists (
            select 1 from public.candidate_experiences e
            where e.candidate_id = c.id and private.job_matches(e.company, e.company_type, cond.x))
          else exists (
            select 1 from public.candidate_experiences e
            where e.candidate_id = c.id and private.job_matches(e.company, e.company_type, cond.x))
        end)
      -- School, degree, field and graduation year on the same education row.
      and ((v_schools is null and v_degrees is null and v_fields is null and v_grad_min is null and v_grad_max is null)
           or exists (
             select 1 from public.candidate_education d
             where d.candidate_id = c.id
               and (v_schools is null or d.school = any(v_schools))
               and (v_degrees is null or d.degree = any(v_degrees))
               and (v_fields is null or d.field = any(v_fields))
               and (v_grad_min is null or d.graduation_year >= v_grad_min)
               and (v_grad_max is null or d.graduation_year <= v_grad_max)))
      and (x_roles is null or c.role <> all(x_roles))
      and (x_cities is null or c.city <> all(x_cities))
      and (x_states is null or c.state <> all(x_states))
      and (x_skills is null or not c.skills && x_skills)
      and ((x_schools is null and x_degrees is null)
           or not exists (
             select 1 from public.candidate_education d
             where d.candidate_id = c.id
               and (d.school = any(coalesce(x_schools, '{}')) or d.degree = any(coalesce(x_degrees, '{}')))))
      and (x_employers is null
           or not exists (select 1 from public.candidate_experiences e where e.candidate_id = c.id and e.company = any(x_employers)))
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
  select r.id, r.rank::integer
  from ranked r
  where r.matched < (select count(*) from public.candidates)
  order by r.rank;
end
$$;

revoke all on function private.filter_list(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function private.filter_int(jsonb, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.filter_bool(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function private.filter_experience(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.job_matches(text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.mentions(text, text) from public, anon, authenticated, service_role;
revoke all on function private.match_candidates(jsonb) from public, anon, authenticated, service_role;
