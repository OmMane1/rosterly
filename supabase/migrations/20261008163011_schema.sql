-- Schema: every table, constraint and index, plus the revoke-then-grant baseline.
--
-- Nothing here is granted to anon/authenticated/service_role and every table has RLS enabled
-- with no policies, so the API roles can reach nothing until a later migration grants exactly
-- what each table needs together with its policies (PLAN.md § 3.2).

-- ---------------------------------------------------------------------------------------------
-- Baseline: objects created by `postgres` start with no privileges for the API roles.
-- `auto_expose_new_tables = false` (config.toml) still leaves TRUNCATE/REFERENCES/TRIGGER/MAINTAIN
-- on new tables, and Postgres grants EXECUTE on every new function to PUBLIC (DECISIONS.md).
-- ---------------------------------------------------------------------------------------------

alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;
-- PUBLIC's EXECUTE is a built-in global default, which only a global (schema-less) revoke removes.
alter default privileges for role postgres revoke execute on functions from public;

revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;
revoke all on all functions in schema public from public, anon, authenticated, service_role;

-- Helpers that must never be reachable over PostgREST live outside the exposed schemas.
create schema private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------------------------

create table public.companies (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z][a-z0-9-]{0,39}$'),
  name       text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now()
);

-- One company per recruiter.
create table public.recruiters (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index recruiters_company_idx on public.recruiters (company_id);

-- The signed-in recruiter's company, or null. SECURITY DEFINER so RLS policies can call it without
-- recursing into the recruiters policy; the company comes from auth.uid(), never a parameter.
create function private.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.company_id from public.recruiters r where r.user_id = (select auth.uid())
$$;
revoke all on function private.current_company_id() from public, anon, authenticated, service_role;

create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
revoke all on function private.touch_updated_at() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Candidates (shared by every company; loaded from data/candidates.json by scripts/seed.ts)
-- ---------------------------------------------------------------------------------------------

create table public.candidates (
  id                       text primary key check (char_length(id) between 1 and 64),
  full_name                text not null,
  avatar_url               text not null,
  headline                 text not null,
  current_title            text not null,
  current_company          text not null,
  current_company_logo_url text not null,
  role                     text not null,
  seniority                text not null check (seniority in ('junior', 'mid', 'senior', 'staff')),
  years_experience         smallint not null check (years_experience between 0 and 80),
  city                     text not null,
  state                    text not null,
  country                  text not null,
  open_to_work             boolean not null,
  skills                   text[] not null check (
                             cardinality(skills) between 1 and 50
                             and array_position(skills, null) is null
                           )
);
-- Filter shapes from PLAN.md § 3.4: skills @> / &&, role (+ seniority), location, years, open_to_work.
create index candidates_skills_gin on public.candidates using gin (skills);
create index candidates_role_seniority_idx on public.candidates (role, seniority);
create index candidates_city_idx on public.candidates (city);
create index candidates_state_idx on public.candidates (state);
create index candidates_years_idx on public.candidates (years_experience);
create index candidates_open_to_work_idx on public.candidates (id) where open_to_work;

-- position 0 is the current job (experiences[0] in the data).
create table public.candidate_experiences (
  candidate_id     text not null references public.candidates (id) on delete cascade,
  position         smallint not null check (position >= 0),
  title            text not null,
  company          text not null,
  company_type     text not null check (company_type in ('enterprise', 'startup')),
  company_logo_url text not null,
  start_year       smallint not null,
  end_year         smallint check (end_year is null or end_year >= start_year),
  description      text not null,
  primary key (candidate_id, position)
);
-- "worked at a startup / at X" are EXISTS probes on these.
create index candidate_experiences_type_idx on public.candidate_experiences (company_type, candidate_id);
create index candidate_experiences_company_idx on public.candidate_experiences (company, candidate_id);
-- "currently at …", and at most one current job per candidate.
create unique index candidate_experiences_current_idx on public.candidate_experiences (candidate_id) where end_year is null;

create table public.candidate_education (
  candidate_id    text not null references public.candidates (id) on delete cascade,
  position        smallint not null check (position >= 0),
  school          text not null,
  degree          text not null,
  field           text not null,
  graduation_year smallint not null,
  primary key (candidate_id, position)
);
create index candidate_education_school_idx on public.candidate_education (school);
create index candidate_education_degree_idx on public.candidate_education (degree);
create index candidate_education_field_idx on public.candidate_education (field);

-- ---------------------------------------------------------------------------------------------
-- Company-owned data. Text rules repeat the API's validation (sanitizeText + lengths), because a
-- recruiter can also write through PostgREST directly.
-- ---------------------------------------------------------------------------------------------

create table public.shortlists (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null default private.current_company_id() references public.companies (id) on delete cascade,
  name       text not null check (
               char_length(name) <= 80
               and name ~ '[^[:space:]]'
               and name !~ '[\u0001-\u001F\u007F-\u009F]'
             ),
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target of shortlist_people's composite FK, which makes cross-company members impossible.
  unique (id, company_id)
);
create index shortlists_company_created_idx on public.shortlists (company_id, created_at desc);
create trigger shortlists_touch_updated_at
  before update on public.shortlists
  for each row execute function private.touch_updated_at();

create table public.shortlist_people (
  shortlist_id uuid not null,
  candidate_id text not null references public.candidates (id) on delete cascade,
  company_id   uuid not null default private.current_company_id(),
  added_by     uuid not null default auth.uid() references auth.users (id),
  added_at     timestamptz not null default now(),
  -- Adding twice is a no-op (`on conflict do nothing`).
  primary key (shortlist_id, candidate_id),
  foreign key (shortlist_id, company_id) references public.shortlists (id, company_id) on delete cascade
);
create index shortlist_people_company_candidate_idx on public.shortlist_people (company_id, candidate_id);

create table public.saved_briefs (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null default private.current_company_id() references public.companies (id) on delete cascade,
  brief      text not null check (
               char_length(brief) <= 1000
               and brief ~ '[^[:space:]]'
               and brief !~ '[\u0001-\u0008\u000B-\u001F\u007F-\u009F]'
             ),
  filters    jsonb not null check (jsonb_typeof(filters) = 'object' and octet_length(filters::text) <= 16384),
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now()
);
create index saved_briefs_company_created_idx on public.saved_briefs (company_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Searches and their frozen ranks. Written only by SECURITY DEFINER functions (M5).
-- ---------------------------------------------------------------------------------------------

create table public.searches (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  recruiter_id uuid not null references auth.users (id),
  brief        text not null check (
                 char_length(brief) <= 1000
                 and brief ~ '[^[:space:]]'
                 and brief !~ '[\u0001-\u0008\u000B-\u001F\u007F-\u009F]'
               ),
  source       text not null check (source in ('brief', 'edit', 'saved')),
  -- A pending search holds a quota reservation; filters and total arrive when it completes.
  status       text not null default 'pending' check (status in ('pending', 'done')),
  filters      jsonb check (filters is null or (jsonb_typeof(filters) = 'object' and octet_length(filters::text) <= 16384)),
  total        integer check (total >= 0),
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  check (status = 'pending' or (filters is not null and total is not null and completed_at is not null)),
  unique (id, company_id)
);
create index searches_company_created_idx on public.searches (company_id, created_at desc);
create index searches_pending_idx on public.searches (company_id, created_at) where status = 'pending';

-- Ranks are stored at search time, so a page is a primary-key range scan.
create table public.search_results (
  search_id    uuid not null,
  rank         integer not null check (rank >= 1),
  company_id   uuid not null,
  candidate_id text not null references public.candidates (id) on delete cascade,
  primary key (search_id, rank),
  -- Every result appears exactly once across pages.
  unique (search_id, candidate_id),
  foreign key (search_id, company_id) references public.searches (id, company_id) on delete cascade
);

-- One row per company; its row lock serialises concurrent quota takers.
create table public.company_usage (
  company_id    uuid primary key references public.companies (id) on delete cascade,
  searches_used integer not null default 0 check (searches_used >= 0)
);

-- ---------------------------------------------------------------------------------------------
-- Billing (written only by apply_stripe_event as service_role, M8)
-- ---------------------------------------------------------------------------------------------

-- One row per Stripe subscription; the plan is paid while any of a company's rows is active or trialing.
create table public.subscriptions (
  stripe_subscription_id text primary key check (char_length(stripe_subscription_id) between 1 and 255),
  company_id             uuid not null references public.companies (id) on delete cascade,
  customer               text check (char_length(customer) <= 255),
  -- Not an enum: an unknown future Stripe status must be stored (and read as "not paid"), not rejected.
  status                 text not null check (char_length(status) between 1 and 64),
  current_period_end     timestamptz,
  -- The newest event applied so far; an older one can never overwrite it (PLAN.md A7).
  last_event_id          text not null check (char_length(last_event_id) between 1 and 255),
  last_event_created     bigint not null,
  last_event_type        text not null check (char_length(last_event_type) between 1 and 255),
  updated_at             timestamptz not null default now()
);
create index subscriptions_company_idx on public.subscriptions (company_id);

create table public.processed_stripe_events (
  event_id    text primary key check (char_length(event_id) between 1 and 255),
  type        text not null check (char_length(type) between 1 and 255),
  created     bigint not null,
  outcome     text not null check (char_length(outcome) between 1 and 64),
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- RLS on every table, no policies yet: deny-all for every role except the owner.
-- ---------------------------------------------------------------------------------------------

alter table public.companies               enable row level security;
alter table public.recruiters              enable row level security;
alter table public.candidates              enable row level security;
alter table public.candidate_experiences   enable row level security;
alter table public.candidate_education     enable row level security;
alter table public.shortlists              enable row level security;
alter table public.shortlist_people        enable row level security;
alter table public.saved_briefs            enable row level security;
alter table public.searches                enable row level security;
alter table public.search_results          enable row level security;
alter table public.company_usage           enable row level security;
alter table public.subscriptions           enable row level security;
alter table public.processed_stripe_events enable row level security;
