-- Initial policy and deterministic historical backfill: 1440 elapsed minutes
-- (24 hours). Existing bookings do not inherit subsequent location changes.
alter table public.locations
  add column customer_cancellation_notice_minutes integer not null default 1440
    constraint locations_customer_cancellation_notice_check
    check (customer_cancellation_notice_minutes between 0 and 43200);

alter table public.bookings add column cancellation_notice_minutes integer;
update public.bookings set cancellation_notice_minutes = 1440;
alter table public.bookings
  alter column cancellation_notice_minutes set not null,
  add constraint bookings_cancellation_notice_check
    check (cancellation_notice_minutes between 0 and 43200);
-- No booking default: every new booking must explicitly snapshot its location.

-- Preserve existing public columns without exposing the new configuration.
revoke select on public.locations from anon, authenticated;
grant select (id, name, slug, address_line1, address_line2, city, postal_code,
  country_code, timezone, currency, is_active, archived_at, display_order,
  created_at, updated_at, is_public) on public.locations to anon, authenticated;
grant insert (customer_cancellation_notice_minutes), update (customer_cancellation_notice_minutes)
  on public.locations to authenticated;
-- Existing active-Admin INSERT/UPDATE RLS policies also govern this field.

create or replace function public.create_customer_booking(
  p_court_id uuid, p_booking_date date, p_starts_at_minute integer,
  p_ends_at_minute integer, p_account_user_id uuid, p_customer_name text,
  p_customer_email text, p_customer_phone text, p_total_amount_minor integer,
  p_currency text
)
returns table (booking_id uuid, reservation_id uuid)
language plpgsql security invoker set search_path = '' as $$
declare created_reservation_id uuid;
declare created_booking_id uuid;
declare location_notice_minutes integer;
begin
  if current_role <> 'service_role' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_account_user_id is not null and not exists (
    select 1 from public.users u where u.id = p_account_user_id and u.status = 'active'
  ) then
    raise exception 'Account unavailable' using errcode = '42501';
  end if;
  select l.customer_cancellation_notice_minutes into location_notice_minutes
    from public.courts c join public.locations l on l.id = c.location_id
    where c.id = p_court_id and c.is_active and l.is_active
      and l.archived_at is null and l.is_public and l.currency = p_currency;
  if not found then
    raise exception 'Court unavailable' using errcode = '23514';
  end if;

  insert into public.court_reservations
    (court_id, booking_date, starts_at_minute, ends_at_minute, status,
     created_by_user_id, reason)
  values (p_court_id, p_booking_date, p_starts_at_minute, p_ends_at_minute,
    'active', null, null)
  returning id into created_reservation_id;

  insert into public.bookings
    (reservation_id, account_user_id, customer_name, customer_email,
     customer_phone, status, total_amount_minor, currency, cancellation_notice_minutes)
  values (created_reservation_id, p_account_user_id, p_customer_name,
    p_customer_email, p_customer_phone, 'confirmed', p_total_amount_minor, p_currency, location_notice_minutes)
  returning id into created_booking_id;

  return query select created_booking_id, created_reservation_id;
end;
$$;

revoke all on function public.create_customer_booking(uuid, date, integer, integer, uuid, text, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.create_customer_booking(uuid, date, integer, integer, uuid, text, text, text, integer, text)
  to service_role;

drop function public.list_admin_operational_occupancy(uuid[], date);
create function public.list_admin_operational_occupancy(p_court_ids uuid[], p_date date)
returns table (
  kind text, id uuid, court_id uuid, booking_date date,
  starts_at_minute integer, ends_at_minute integer,
  reason text, created_by_user_id uuid, creator_name text,
  customer_name text, customer_email text, customer_phone text,
  total_amount_minor integer, currency text, cancellation_notice_minutes integer
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_role('admin') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select case when b.id is null then 'reservation' else 'booking' end,
      coalesce(b.id, r.id), r.court_id, r.booking_date,
      r.starts_at_minute, r.ends_at_minute,
      case when b.id is null then r.reason else null end,
      case when b.id is null then r.created_by_user_id else null end,
      case when b.id is null then nullif(concat_ws(' ', u.first_name, u.last_name), '') else null end,
      b.customer_name, b.customer_email, b.customer_phone,
      b.total_amount_minor, b.currency, b.cancellation_notice_minutes
    from public.court_reservations r
    join public.courts c on c.id = r.court_id and c.is_active
    join public.locations l on l.id = c.location_id and l.is_active and l.archived_at is null
    left join public.bookings b on b.reservation_id = r.id
    left join public.users u on u.id = r.created_by_user_id and b.id is null
    where r.court_id = any(p_court_ids) and r.booking_date = p_date
      and r.status = 'active' and (b.id is null or b.status = 'confirmed');
end;
$$;

revoke all on function public.list_admin_operational_occupancy(uuid[], date) from public, anon;
grant execute on function public.list_admin_operational_occupancy(uuid[], date) to authenticated;


