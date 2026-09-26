-- ============================================================
-- AUTH / APPLICATION USER / RBAC FOUNDATION
-- ============================================================
--
-- Supabase owns:
--   auth.users
--   authentication credentials
--   identities
--   sessions
--
-- The application owns:
--   public.users
--   public.roles
--   public.user_roles
--
-- public.users.id is deliberately the same UUID as auth.users.id.
-- There is exactly one application account for one Auth user.
-- ============================================================


-- ============================================================
-- USER STATUS
-- ============================================================

create type public.user_status as enum (
  'active',
  'suspended'
);


-- ============================================================
-- APPLICATION USERS
-- ============================================================

create table public.users (
  -- Restrict Auth deletion so application identity/history cannot disappear through a cascade.
  id uuid primary key
    references auth.users(id)
    on delete restrict,

  -- auth.users remains the source of truth for the login email.
  -- We keep a synchronized copy because application/admin queries
  -- should not depend on querying Supabase's internal auth schema.
  email text not null,

  -- Application-level account state.
  -- Authentication and application authorization are separate:
  -- Supabase may know who the user is while our application may
  -- still deny access because this account is suspended.
  status public.user_status not null default 'active',

  -- Application account creation time; account/RBAC mutations do not change it.
  created_at timestamptz not null default now(),
  -- Latest account/RBAC modification, excluding unrelated tennis/domain data.
  updated_at timestamptz not null default now()
);


-- Email lookup will be common in administration.
-- lower(email) also gives us case-insensitive uniqueness.
create unique index users_email_lower_unique
  on public.users (lower(email));


-- ============================================================
-- ROLES
-- ============================================================

create table public.roles (
  code text primary key,

  constraint roles_code_format
    check (code ~ '^[a-z][a-z0-9_]*$')
);


-- Lookup codes exist only for referential integrity.
insert into public.roles (code)
values ('admin'), ('coach'), ('member');


-- ============================================================
-- USER ↔ ROLE ASSIGNMENTS
-- ============================================================

create table public.user_roles (
  user_id uuid not null
    references public.users(id)
    on delete cascade,

  role_code text not null
    references public.roles(code)
    on delete restrict,

  -- When this role was granted.
  assigned_at timestamptz not null default now(),

  -- Who granted it.
  --
  -- NULL is allowed because automatic provisioning and controlled
  -- bootstrap operations do not necessarily have an authenticated
  -- application user acting as the assigner.
  assigned_by uuid
    references public.users(id)
    on delete set null,

  primary key (user_id, role_code)
);


create index user_roles_role_code_idx
  on public.user_roles (role_code);


-- ============================================================
-- GENERIC updated_at SUPPORT
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


create trigger users_set_updated_at
before update on public.users
for each row
execute function public.set_updated_at();


-- Role mutations only maintain account metadata; role decisions stay in TypeScript.
create function public.touch_user_updated_at_from_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    update public.users set updated_at = now() where id = old.user_id;
  elsif tg_op = 'INSERT' then
    update public.users set updated_at = now() where id = new.user_id;
  else
    update public.users set updated_at = now() where id = new.user_id;
    if old.user_id is distinct from new.user_id then
      update public.users set updated_at = now() where id = old.user_id;
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.touch_user_updated_at_from_role_change() from public;

create trigger user_roles_touch_user_updated_at
after insert or delete or update of user_id, role_code on public.user_roles
for each row
execute function public.touch_user_updated_at_from_role_change();


-- ============================================================
-- AUTH USER → APPLICATION USER PROVISIONING
-- ============================================================

create or replace function public.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Create our application-owned user row.
  insert into public.users (
    id,
    email
  )
  values (
    new.id,
    new.email
  );

  -- Every normal registered account begins with the member role.
  insert into public.user_roles (
    user_id,
    role_code,
    assigned_by
  )
  values (
    new.id,
    'member',
    null
  );

  return new;
end;
$$;


revoke all
on function public.handle_auth_user_created()
from public;


create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_auth_user_created();


-- ============================================================
-- AUTH EMAIL SYNCHRONIZATION
-- ============================================================
--
-- auth.users.email is authoritative.
--
-- public.users.email is only the application-side synchronized copy.
-- Users/admins must not directly modify public.users.email.
-- ============================================================

create or replace function public.handle_auth_user_email_updated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.users
    set email = new.email
    where id = new.id;
  end if;

  return new;
end;
$$;


revoke all
on function public.handle_auth_user_email_updated()
from public;


create trigger on_auth_user_email_updated
after update of email on auth.users
for each row
execute function public.handle_auth_user_email_updated();


-- ============================================================
-- CURRENT USER HELPERS
-- ============================================================

create or replace function public.has_role(required_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.users u
      on u.id = ur.user_id
    where ur.user_id = (select auth.uid())
      and ur.role_code = required_role
      and u.status = 'active'
  );
$$;


revoke all
on function public.has_role(text)
from public;

grant execute
on function public.has_role(text)
to authenticated;


-- ============================================================
-- ROLE ASSIGNMENT AUDIT
-- ============================================================
--
-- For role assignments made by an authenticated administrator,
-- assigned_by must always be the actual authenticated user.
--
-- The client cannot spoof another administrator's UUID.
-- ============================================================

create or replace function public.set_role_assigned_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.assigned_by = auth.uid();
  end if;

  return new;
end;
$$;


create trigger user_roles_set_assigned_by
before insert on public.user_roles
for each row
execute function public.set_role_assigned_by();


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.users
enable row level security;

alter table public.roles
enable row level security;

alter table public.user_roles
enable row level security;


-- ------------------------------------------------------------
-- public.users
-- ------------------------------------------------------------

-- A user can see their own application account.
--
-- An active administrator can see all application accounts.
create policy users_select
on public.users
for select
to authenticated
using (
  id = (select auth.uid())
  or public.has_role('admin')
);


-- Only an active administrator may change application account status.
--
-- Column-level GRANT below ensures that even an administrator cannot
-- use this policy to directly change email/id/timestamps.
create policy users_update_status
on public.users
for update
to authenticated
using (
  public.has_role('admin')
)
with check (
  public.has_role('admin')
);


-- ------------------------------------------------------------
-- public.user_roles
-- ------------------------------------------------------------

-- Users can inspect their own roles.
--
-- Administrators can inspect everybody's roles.
create policy user_roles_select
on public.user_roles
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.has_role('admin')
);


-- Only administrators can grant roles.
create policy user_roles_insert
on public.user_roles
for insert
to authenticated
with check (
  public.has_role('admin')
);


-- Only administrators can revoke roles.
create policy user_roles_delete
on public.user_roles
for delete
to authenticated
using (
  public.has_role('admin')
);


-- ============================================================
-- DATABASE PRIVILEGES
-- ============================================================
--
-- RLS is necessary, but table privileges are also explicit.
-- ============================================================

revoke all
on table public.users
from anon, authenticated;

revoke all
on table public.roles
from anon, authenticated;

revoke all
on table public.user_roles
from anon, authenticated;


-- Users/admins can read application accounts according to RLS.
grant select
on table public.users
to authenticated;


-- The only mutable public.users field exposed to authenticated
-- requests is status.
--
-- RLS further restricts this operation to admins.
grant update (status)
on table public.users
to authenticated;


grant select, insert, delete
on table public.user_roles
to authenticated;
