-- Private objects; the authenticated Next.js image endpoint downloads under caller RLS.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-avatars', 'profile-avatars', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp']);

create policy profile_avatars_select on storage.objects for select to authenticated
using (bucket_id = 'profile-avatars' and exists
  (select 1 from public.users where id = (select auth.uid()) and status = 'active'));

create policy profile_avatars_insert on storage.objects for insert to authenticated
with check (bucket_id = 'profile-avatars'
  and name in ((select auth.uid())::text || '/avatar.jpg',
    (select auth.uid())::text || '/avatar.png', (select auth.uid())::text || '/avatar.webp')
  and exists (select 1 from public.users where id = (select auth.uid()) and status = 'active'));

create policy profile_avatars_update on storage.objects for update to authenticated
using (bucket_id = 'profile-avatars'
  and name in ((select auth.uid())::text || '/avatar.jpg',
    (select auth.uid())::text || '/avatar.png', (select auth.uid())::text || '/avatar.webp')
  and exists (select 1 from public.users where id = (select auth.uid()) and status = 'active'))
with check (bucket_id = 'profile-avatars'
  and name in ((select auth.uid())::text || '/avatar.jpg',
    (select auth.uid())::text || '/avatar.png', (select auth.uid())::text || '/avatar.webp')
  and exists (select 1 from public.users where id = (select auth.uid()) and status = 'active'));

create policy profile_avatars_delete on storage.objects for delete to authenticated
using (bucket_id = 'profile-avatars'
  and name in ((select auth.uid())::text || '/avatar.jpg',
    (select auth.uid())::text || '/avatar.png', (select auth.uid())::text || '/avatar.webp')
  and exists (select 1 from public.users where id = (select auth.uid()) and status = 'active'));
