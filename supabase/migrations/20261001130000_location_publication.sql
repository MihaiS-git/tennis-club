-- Existing and new locations require an explicit administrator publication decision.
alter table public.locations add column is_public boolean not null default false;
grant insert (is_public) on public.locations to authenticated;
grant update (is_public) on public.locations to authenticated;

drop policy locations_select on public.locations;
create policy locations_select on public.locations for select to anon, authenticated
using (is_active and archived_at is null and is_public);

drop policy courts_select on public.courts;
create policy courts_select on public.courts for select to anon, authenticated
using (is_active and exists (
  select 1 from public.locations
  where id = courts.location_id and is_active and archived_at is null and is_public
));
