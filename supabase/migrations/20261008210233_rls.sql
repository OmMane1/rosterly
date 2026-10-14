-- RLS policies and grants (PLAN.md § 3.2). Each table gets exactly the privileges the app needs,
-- granted to `authenticated` only, together with the policy that scopes them to the caller's company.
-- anon and service_role get nothing on any table; PUBLIC never had anything (schema baseline).
--
-- Inserts and updates use column-level grants, so company_id, created_by and ids always come from
-- the column defaults (private.current_company_id(), auth.uid()) and can't be supplied or changed.

-- Policies and column defaults run as the caller, so the caller must be able to run the helper.
-- PostgREST still can't reach it: `private` is not an exposed schema.
grant usage on schema private to authenticated;
grant execute on function private.current_company_id() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Tenants: a recruiter sees their own company and their own recruiter row, and changes neither.
-- ---------------------------------------------------------------------------------------------

grant select on public.companies to authenticated;
create policy companies_own on public.companies
  for select to authenticated
  using (id = (select private.current_company_id()));

grant select on public.recruiters to authenticated;
create policy recruiters_self on public.recruiters
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------
-- Candidates: read-only, and only for a signed-in recruiter (a user with no company sees none).
-- ---------------------------------------------------------------------------------------------

grant select on public.candidates to authenticated;
create policy candidates_recruiters on public.candidates
  for select to authenticated
  using ((select private.current_company_id()) is not null);

grant select on public.candidate_experiences to authenticated;
create policy candidate_experiences_recruiters on public.candidate_experiences
  for select to authenticated
  using ((select private.current_company_id()) is not null);

grant select on public.candidate_education to authenticated;
create policy candidate_education_recruiters on public.candidate_education
  for select to authenticated
  using ((select private.current_company_id()) is not null);

-- ---------------------------------------------------------------------------------------------
-- Company-owned data the recruiter edits.
-- ---------------------------------------------------------------------------------------------

grant select, delete on public.shortlists to authenticated;
grant insert (name), update (name) on public.shortlists to authenticated;
create policy shortlists_company on public.shortlists
  for all to authenticated
  using (company_id = (select private.current_company_id()))
  with check (company_id = (select private.current_company_id()));

-- The composite FK to shortlists (id, company_id) also rejects another company's list.
grant select, delete on public.shortlist_people to authenticated;
grant insert (shortlist_id, candidate_id) on public.shortlist_people to authenticated;
create policy shortlist_people_company on public.shortlist_people
  for all to authenticated
  using (company_id = (select private.current_company_id()))
  with check (company_id = (select private.current_company_id()));

grant select, delete on public.saved_briefs to authenticated;
grant insert (brief, filters) on public.saved_briefs to authenticated;
create policy saved_briefs_company on public.saved_briefs
  for all to authenticated
  using (company_id = (select private.current_company_id()))
  with check (company_id = (select private.current_company_id()));

-- ---------------------------------------------------------------------------------------------
-- Read-only for the recruiter: written only by SECURITY DEFINER functions (M5, M8).
-- ---------------------------------------------------------------------------------------------

grant select on public.searches to authenticated;
create policy searches_company on public.searches
  for select to authenticated
  using (company_id = (select private.current_company_id()));

grant select on public.search_results to authenticated;
create policy search_results_company on public.search_results
  for select to authenticated
  using (company_id = (select private.current_company_id()));

grant select on public.company_usage to authenticated;
create policy company_usage_company on public.company_usage
  for select to authenticated
  using (company_id = (select private.current_company_id()));

grant select on public.subscriptions to authenticated;
create policy subscriptions_company on public.subscriptions
  for select to authenticated
  using (company_id = (select private.current_company_id()));

-- processed_stripe_events: no grant and no policy. Only apply_stripe_event (M8) touches it.
