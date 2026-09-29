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
  environment text not null check (environment in ('outdoor', 'indoor', 'covered')),
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
create policy courts_select on public.courts for select to anon, authenticated
using (is_active and exists (
  select 1 from public.locations where id = courts.location_id and is_active
));
