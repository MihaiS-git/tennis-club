create type public.booking_status as enum ('confirmed', 'cancelled');

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null unique references public.court_reservations(id) on delete restrict,
  account_user_id uuid references public.users(id) on delete restrict,
  customer_name text not null constraint bookings_customer_name_check
    check (char_length(customer_name) <= 200 and char_length(btrim(customer_name)) > 0),
  customer_email text not null constraint bookings_customer_email_check
    check (char_length(customer_email) <= 320 and char_length(btrim(customer_email)) > 0),
  customer_phone text not null constraint bookings_customer_phone_check
    check (char_length(customer_phone) <= 50 and char_length(btrim(customer_phone)) > 0),
  status public.booking_status not null default 'confirmed',
  total_amount_minor integer not null constraint bookings_amount_check check (total_amount_minor > 0),
  currency text not null constraint bookings_currency_check check (currency in ('EUR', 'USD', 'GBP', 'RON', 'CHF')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger bookings_set_updated_at before update on public.bookings
for each row execute function public.set_updated_at();

create index bookings_account_user_id_idx on public.bookings(account_user_id);

alter table public.bookings enable row level security;
revoke all on public.bookings from public, anon, authenticated;

-- Only the server's service role can call this transaction. Validation and
-- pricing happen in TypeScript; PostgreSQL persists both rows atomically.
create function public.create_customer_booking(
  p_court_id uuid, p_booking_date date, p_starts_at_minute integer,
  p_ends_at_minute integer, p_account_user_id uuid, p_customer_name text,
  p_customer_email text, p_customer_phone text, p_total_amount_minor integer,
  p_currency text
)
returns table (booking_id uuid, reservation_id uuid)
language plpgsql security invoker set search_path = '' as $$
declare created_reservation_id uuid;
declare created_booking_id uuid;
begin
  if current_role <> 'service_role' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_account_user_id is not null and not exists (
    select 1 from public.users u where u.id = p_account_user_id and u.status = 'active'
  ) then
    raise exception 'Account unavailable' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.courts c join public.locations l on l.id = c.location_id
    where c.id = p_court_id and c.is_active and l.is_active
      and l.archived_at is null and l.is_public and l.currency = p_currency
  ) then
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
     customer_phone, status, total_amount_minor, currency)
  values (created_reservation_id, p_account_user_id, p_customer_name,
    p_customer_email, p_customer_phone, 'confirmed', p_total_amount_minor, p_currency)
  returning id into created_booking_id;

  return query select created_booking_id, created_reservation_id;
end;
$$;

revoke all on function public.create_customer_booking(uuid, date, integer, integer, uuid, text, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.create_customer_booking(uuid, date, integer, integer, uuid, text, text, text, integer, text)
  to service_role;
