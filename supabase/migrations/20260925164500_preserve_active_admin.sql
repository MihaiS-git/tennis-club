-- Serialize changes that can remove an active administrator. Updating one
-- guard row makes concurrent transactions wait (or fail serialization at
-- stronger isolation levels) before checking the resulting administrator set.
create table public.active_admin_guard (
  id boolean primary key default true check (id),
  revision bigint not null default 0
);

insert into public.active_admin_guard (id) values (true);

alter table public.active_admin_guard enable row level security;
revoke all on table public.active_admin_guard from public, anon, authenticated, service_role;

create function public.preserve_active_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.active_admin_guard
  set revision = revision + 1
  where id = true;

  if not exists (
    select 1
    from public.users u
    join public.user_roles ur on ur.user_id = u.id
    where u.status = 'active'
      and ur.role_code = 'admin'
  ) then
    raise exception 'At least one active administrator must remain.'
      using errcode = '23514';
  end if;

  return null;
end;
$$;

revoke all on function public.preserve_active_admin() from public;

create trigger users_preserve_active_admin
after update of status on public.users
for each row
when (old.status = 'active' and new.status <> 'active')
execute function public.preserve_active_admin();

create trigger user_roles_preserve_active_admin_delete
after delete on public.user_roles
for each row
when (old.role_code = 'admin')
execute function public.preserve_active_admin();

create trigger user_roles_preserve_active_admin_update
after update of user_id, role_code on public.user_roles
for each row
when (old.role_code = 'admin' and
      (old.user_id is distinct from new.user_id or old.role_code is distinct from new.role_code))
execute function public.preserve_active_admin();
