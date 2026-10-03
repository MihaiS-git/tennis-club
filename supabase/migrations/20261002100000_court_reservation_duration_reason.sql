alter table public.court_reservations
  drop constraint court_reservation_time_check,
  add constraint court_reservation_time_check check (
    starts_at_minute % 30 = 0
    and ends_at_minute % 30 = 0
    and ends_at_minute - starts_at_minute >= 60
  ),
  add column reason text,
  add constraint court_reservation_reason_check check (
    reason is null or (char_length(reason) <= 255 and char_length(btrim(reason)) > 0)
  );
