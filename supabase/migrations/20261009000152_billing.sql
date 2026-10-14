-- Stripe webhook state (PLAN.md § 3.6). The route verifies the signature and reads the event
-- (lib/server/billing); this function makes applying it idempotent and order-safe.
--
--   apply_stripe_event  DEFINER, service_role only. Returns the outcome:
--     duplicate        the event id was processed before (nothing changes)
--     ignored          a type that doesn't change a subscription (recorded)
--     unknown_company  names no company we have and no known subscription (recorded)
--     stale            older than what the subscription already reflects (recorded)
--     applied          the subscription row now reflects this event
--
-- The company comes from the event's metadata.company, not from auth.uid(): Stripe is the caller,
-- and only the webhook handler (secret key, after signature verification) can execute this.

-- Tie-break for events of one subscription with the same `created` second, in lifecycle order: a
-- subscription is created, its checkout completes, it is updated, it is deleted (PLAN.md A7).
create function private.stripe_event_rank(p_type text)
returns smallint
language sql
immutable
as $$
  select case
    when p_type = 'customer.subscription.deleted' then 4
    when p_type = 'customer.subscription.created' then 1
    when pg_catalog.starts_with(p_type, 'customer.subscription.') then 3
    when pg_catalog.starts_with(p_type, 'checkout.session.') then 2
    else 0
  end::smallint
$$;
revoke all on function private.stripe_event_rank(text) from public, anon, authenticated, service_role;

create function public.apply_stripe_event(
  p_event_id text,
  p_type text,
  p_created bigint,
  -- The rest are null for an event that changes no subscription.
  p_subscription_id text,
  p_status text,
  p_company text,
  p_customer text,
  p_current_period_end bigint
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found   boolean;
  v_current public.subscriptions%rowtype;
  v_company uuid;
  v_outcome text;
begin
  -- Idempotency: the primary key claims the event id. A concurrent delivery of the same id blocks
  -- here until this transaction ends, then inserts nothing and returns 'duplicate'.
  insert into public.processed_stripe_events (event_id, type, created, outcome)
  values (p_event_id, p_type, p_created, 'processing')
  on conflict (event_id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  if p_subscription_id is null then
    v_outcome := 'ignored';
  else
    -- One subscription's events apply one at a time, so the read and the write below can't
    -- interleave with another event for it (including one that creates the row).
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stripe_subscription:' || p_subscription_id, 0));
    select * into v_current from public.subscriptions s where s.stripe_subscription_id = p_subscription_id;
    v_found := found;

    -- metadata.company names the company; without it (or naming none of ours) the subscription
    -- stays with the company that already has it (PLAN.md A8).
    select c.id into v_company from public.companies c where c.slug = pg_catalog.lower(p_company);
    if v_company is null and v_found then
      v_company := v_current.company_id;
    end if;

    if v_company is null then
      v_outcome := 'unknown_company';
    elsif v_found and (p_created, private.stripe_event_rank(p_type), p_event_id collate "C")
        <= (v_current.last_event_created, private.stripe_event_rank(v_current.last_event_type), v_current.last_event_id collate "C") then
      -- An older event never overwrites newer state.
      v_outcome := 'stale';
    else
      insert into public.subscriptions as s (stripe_subscription_id, company_id, customer, status, current_period_end,
                                             last_event_id, last_event_created, last_event_type)
      values (p_subscription_id, v_company, p_customer, p_status, pg_catalog.to_timestamp(p_current_period_end),
              p_event_id, p_created, p_type)
      on conflict (stripe_subscription_id) do update set
        company_id         = excluded.company_id,
        -- A newer event that omits these says nothing about them.
        customer           = coalesce(excluded.customer, s.customer),
        current_period_end = coalesce(excluded.current_period_end, s.current_period_end),
        status             = excluded.status,
        last_event_id      = excluded.last_event_id,
        last_event_created = excluded.last_event_created,
        last_event_type    = excluded.last_event_type,
        updated_at         = now();
      v_outcome := 'applied';
    end if;
  end if;

  update public.processed_stripe_events e set outcome = v_outcome where e.event_id = p_event_id;
  return v_outcome;
end
$$;

-- Revoke first, then grant to exactly one role (CLAUDE.md § Database rules).
revoke all on function public.apply_stripe_event(text, text, bigint, text, text, text, text, bigint) from public, anon, authenticated, service_role;
grant execute on function public.apply_stripe_event(text, text, bigint, text, text, text, text, bigint) to service_role;
