-- Physical locations of one club, not tenants.
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  address_line1 text,
  address_line2 text,
  city text,
  postal_code text,
  country_code text,
  timezone text not null,
  currency text not null default 'EUR'
    constraint locations_currency_check check (currency in ('EUR', 'USD', 'GBP', 'RON', 'CHF')),
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.courts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  name text not null,
  slug text not null,
  surface text not null check (surface in ('clay', 'hard', 'grass', 'carpet')),
  environment text not null check (environment in ('outdoor', 'indoor')),
  has_lighting boolean not null default false,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, slug)
);

alter table public.locations enable row level security;
alter table public.courts enable row level security;
revoke all on public.locations, public.courts from anon, authenticated;
grant select on public.locations, public.courts to anon, authenticated;

create policy locations_select on public.locations for select to anon, authenticated
using (is_active);
-- Separate authenticated policies keep the admin helper out of anonymous reads.
create policy locations_admin_select on public.locations for select to authenticated
using ((select public.has_role('admin')));
grant insert (name, slug, address_line1, address_line2, city, postal_code,
  country_code, timezone, currency, is_active, display_order, updated_at)
  on public.locations to authenticated;
grant update (name, address_line1, address_line2, city, postal_code,
  country_code, timezone, currency, is_active, display_order, updated_at)
  on public.locations to authenticated;
create policy locations_admin_insert on public.locations for insert to authenticated
with check ((select public.has_role('admin')));
create policy locations_admin_update on public.locations for update to authenticated
using ((select public.has_role('admin')))
with check ((select public.has_role('admin')));
create policy courts_select on public.courts for select to anon, authenticated
using (is_active and exists (
  select 1 from public.locations where id = courts.location_id and is_active
));
create policy courts_admin_select on public.courts for select to authenticated
using ((select public.has_role('admin')));
grant insert (location_id, name, slug, surface, environment, has_lighting,
  is_active, display_order, updated_at) on public.courts to authenticated;
grant update (location_id, name, surface, environment, has_lighting,
  is_active, display_order, updated_at) on public.courts to authenticated;
create policy courts_admin_insert on public.courts for insert to authenticated
with check ((select public.has_role('admin')));
create policy courts_admin_update on public.courts for update to authenticated
using ((select public.has_role('admin')))
with check ((select public.has_role('admin')));
