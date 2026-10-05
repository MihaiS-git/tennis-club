-- Owner entrypoints reuse the Admin same-row transaction and pricing implementation.
create or replace function public.read_own_booking_edit_availability(p_id uuid, p_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.read_customer_booking_edit_availability(p_id, p_date, true);
$$;
create or replace function public.reschedule_own_customer_booking(
  p_id uuid, p_expected_updated_at timestamptz, p_expected_booking_updated_at timestamptz,
  p_court_id uuid, p_booking_date date, p_starts_at_minute integer, p_ends_at_minute integer,
  p_save boolean, p_expected_total integer, p_price_acknowledged boolean
) returns jsonb language sql security definer set search_path = '' as $$
  select public.reschedule_customer_booking(p_id, p_expected_updated_at, p_expected_booking_updated_at,
    p_court_id, p_booking_date, p_starts_at_minute, p_ends_at_minute,
    p_save, p_expected_total, p_price_acknowledged, true);
$$;
revoke all on function public.read_own_booking_edit_availability(uuid, date) from public, anon;
grant execute on function public.read_own_booking_edit_availability(uuid, date) to authenticated;
revoke all on function public.reschedule_own_customer_booking(uuid, timestamptz, timestamptz, uuid, date, integer, integer, boolean, integer, boolean) from public, anon;
grant execute on function public.reschedule_own_customer_booking(uuid, timestamptz, timestamptz, uuid, date, integer, integer, boolean, integer, boolean) to authenticated;
