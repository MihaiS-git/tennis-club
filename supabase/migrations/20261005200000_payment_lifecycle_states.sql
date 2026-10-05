-- Enum additions commit before the payment foundation uses the new values.
alter type public.booking_status add value 'pending_payment';
alter type public.booking_status add value 'failed';
alter type public.booking_status add value 'expired';
alter type public.court_reservation_status add value 'held';
alter type public.court_reservation_status add value 'released';
