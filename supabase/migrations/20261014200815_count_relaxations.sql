-- Counts for "widen the search" (DECISIONS.md "Suggesting a broader search when nothing matches").
-- When a search finds no one, the API offers to drop one of its filters and shows how many people
-- each choice would find. count_relaxations returns those counts without starting a search.
--
--   count_relaxations  INVOKER  jsonb array of counts, one per variant, in order
--
-- Each variant must be the stored search's own filters with parts taken away (jsonb containment:
-- `stored @> variant`). So the counts are always about a search the company already ran, and no
-- caller-chosen filter set is ever counted for free. The search is read under RLS, so another
-- company's id is 42501 (→ 404) like an unknown one.
--
-- INVOKER (CLAUDE.md § Database rules: read-only), so authenticated now executes match_candidates
-- and the pure helpers it calls. That opens no data: recruiters can already read every candidate,
-- and `private` is not an exposed schema, so none of these is an RPC.

create function public.count_relaxations(p_search_id uuid, p_variants jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_filters jsonb;
begin
  select s.filters into v_filters
  from public.searches s
  where s.id = p_search_id and s.status = 'done';
  if v_filters is null then
    raise exception using errcode = '42501', message = 'no such search for this company';
  end if;

  if pg_catalog.jsonb_typeof(p_variants) is distinct from 'array' or pg_catalog.jsonb_array_length(p_variants) > 25 then
    raise exception using errcode = '23514', message = 'variants must be an array of at most 25 filter objects';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_variants) v(f)
    where pg_catalog.jsonb_typeof(v.f) <> 'object' or not v_filters operator(pg_catalog.@>) v.f
  ) then
    raise exception using errcode = '23514', message = 'each variant must be the search''s own filters with parts removed';
  end if;

  return coalesce(
    (select pg_catalog.jsonb_agg((select count(*) from private.match_candidates(v.f)) order by v.ord)
     from pg_catalog.jsonb_array_elements(p_variants) with ordinality v(f, ord)),
    '[]'::jsonb);
end
$$;

-- Revoke first, then grant to exactly one role (CLAUDE.md § Database rules).
revoke all on function public.count_relaxations(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.count_relaxations(uuid, jsonb) to authenticated;

-- An INVOKER caller needs EXECUTE on everything match_candidates runs.
grant execute on function private.match_candidates(jsonb) to authenticated;
grant execute on function private.filter_list(jsonb, text) to authenticated;
grant execute on function private.filter_int(jsonb, text, integer, integer) to authenticated;
grant execute on function private.filter_bool(jsonb, text) to authenticated;
grant execute on function private.filter_experience(jsonb) to authenticated;
grant execute on function private.mentions(text, text) to authenticated;
