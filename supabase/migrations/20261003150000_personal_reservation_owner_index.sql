-- The mixed history read selects only the signed-in staff member's direct rows.
create index court_reservations_personal_owner_idx
  on public.court_reservations (created_by_user_id)
  where created_by_user_id is not null;
