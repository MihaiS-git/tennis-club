-- A reservation uses the court location's calendar date and minute-of-day.
-- All rows block overlaps until a later booking workflow defines cancellation.
create table public.court_reservations (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references public.courts(id),
  booking_date date not null check (isfinite(booking_date)),
  starts_at_minute integer not null check (starts_at_minute between 0 and 1439),
  ends_at_minute integer not null check (ends_at_minute between 1 and 1440),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint court_reservation_time_check check (
    starts_at_minute % 30 = 0
    and ends_at_minute % 30 = 0
    and ends_at_minute - starts_at_minute in (60, 90, 120)
  ),
  constraint court_reservation_no_overlap exclude using gist (
    court_id with =,
    booking_date with =,
    int4range(starts_at_minute, ends_at_minute, '[)') with &&
  )
);

alter table public.court_reservations enable row level security;
revoke all on public.court_reservations from public, anon, authenticated;
