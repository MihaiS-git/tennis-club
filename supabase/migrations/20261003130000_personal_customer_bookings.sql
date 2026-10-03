-- Keep private booking snapshots behind an owner-bound projection. No table
-- SELECT grant is needed for browser roles.
create function public.list_own_upcoming_customer_bookings()
returns table (
  id uuid, booking_date date, starts_at_minute integer, ends_at_minute integer,
  location_name text, location_timezone text, court_name text,
  customer_name text, customer_email text, customer_phone text,
  total_amount_minor integer, currency text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.users u where u.id = (select auth.uid()) and u.status = 'active') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select b.id, r.booking_date, r.starts_at_minute, r.ends_at_minute,
      l.name, l.timezone, c.name,
      b.customer_name, b.customer_email, b.customer_phone,
      b.total_amount_minor, b.currency
    from public.bookings b
    join public.court_reservations r on r.id = b.reservation_id
    join public.courts c on c.id = r.court_id
    join public.locations l on l.id = c.location_id
    where b.account_user_id = (select auth.uid())
      and b.status = 'confirmed' and r.status = 'active'
      and r.booking_date >= (now() at time zone l.timezone)::date
      and (r.booking_date > (now() at time zone l.timezone)::date
        or r.ends_at_minute > extract(hour from now() at time zone l.timezone)::integer * 60
          + extract(minute from now() at time zone l.timezone)::integer)
    order by r.booking_date, r.starts_at_minute, b.id;
end;
$$;

revoke all on function public.list_own_upcoming_customer_bookings() from public, anon;
grant execute on function public.list_own_upcoming_customer_bookings() to authenticated;
