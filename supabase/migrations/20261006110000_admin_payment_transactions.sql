-- Read-only Admin projection. Browser roles retain no direct financial table access.
create function public.list_admin_payment_transactions(
  p_page integer default 1, p_status text default 'all', p_provider text default 'all',
  p_method text default 'all', p_attention boolean default false, p_search text default '',
  p_sort text default 'date', p_direction text default 'desc'
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not public.has_role('admin') then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_page is null or p_page not between 1 and 1000000
    or p_status is null or p_status not in ('all','pending','succeeded','failed','cancelled','expired','due')
    or p_provider is null or p_provider not in ('all','stripe','netopia')
    or p_method is null or p_method not in ('all','online','pay_at_club')
    or p_attention is null or p_search is null or length(p_search) > 200
    or p_sort is null or p_sort not in ('date','amount','payment')
    or p_direction is null or p_direction not in ('asc','desc') then
    raise exception 'Invalid payment query' using errcode = '22023';
  end if;
  with transactions as (
    select b.id as booking_id, b.reservation_id, b.customer_name, b.customer_email,
      coalesce(p.amount_minor, b.total_amount_minor) as amount_minor,
      coalesce(p.currency, b.currency) as currency,
      coalesce(p.method, b.payment_method) as method, p.provider, p.status as payment_status,
      p.provider_payment_id, coalesce(p.created_at, b.created_at) as created_at,
      coalesce(p.updated_at, b.updated_at) as updated_at,
      r.booking_date, r.starts_at_minute, r.ends_at_minute, c.name as court_name,
      l.name as location_name, l.timezone as location_timezone,
      case when f.id is null then null else jsonb_build_object(
        'id',f.id,'amount_minor',f.amount_minor,'currency',f.currency,'status',f.status,
        'provider_refund_id',f.provider_refund_id,'requested_by_user_id',f.requested_by_user_id,
        'requested_by_name',nullif(concat_ws(' ',u.first_name,u.last_name),''),
        'created_at',f.created_at,'updated_at',f.updated_at,'last_error',f.last_error) end as refund,
      coalesce(e.reconciliation, '[]'::jsonb) as reconciliation,
      (coalesce(f.status in ('pending_retry','failed'), false) or coalesce(e.required,false)) as needs_attention
    from public.bookings b
    join public.court_reservations r on r.id = b.reservation_id
    join public.courts c on c.id = r.court_id
    join public.locations l on l.id = c.location_id
    left join public.payment_refunds f on f.booking_id = b.id
    left join public.users u on u.id = f.requested_by_user_id
    left join lateral (
      select a.* from public.payment_attempts a where a.booking_id = b.id
      order by (a.id = f.payment_attempt_id) desc nulls last,
        (a.status = 'succeeded') desc,
        case when a.status = 'succeeded' then a.created_at end asc,
        a.created_at desc, a.id limit 1
    ) p on true
    left join lateral (
      select true as required, jsonb_agg(jsonb_build_object('settlement_result', ev.settlement_result,
        'outcome', ev.outcome, 'received_at', ev.received_at) order by ev.received_at, ev.event_id) as reconciliation
      from public.payment_provider_events ev join public.payment_attempts a on a.id = ev.attempt_id
      where a.booking_id = b.id and ev.reconciliation_required
      having count(*) > 0
    ) e on true
  ), filtered as materialized (
    select * from transactions t where (p_status = 'all' or t.payment_status = p_status)
      and (p_provider = 'all' or t.provider = p_provider)
      and (p_method = 'all' or t.method = p_method)
      and (not p_attention or t.needs_attention)
      -- Literal substring matching: %, _ and other input are not SQL patterns.
      and (p_search = '' or strpos(lower(t.customer_name),lower(p_search)) > 0
        or strpos(lower(t.customer_email),lower(p_search)) > 0
        or strpos(t.booking_id::text,lower(p_search)) > 0
        or strpos(lower(coalesce(t.provider_payment_id,'')),lower(p_search)) > 0)
  ), stats as (
    select count(*)::integer as total, greatest(1,ceil(count(*) / 20.0)::integer) as total_pages from filtered
  ), ordered as (
    select t.*, row_number() over (order by
      case when p_sort = 'date' and p_direction = 'asc' then t.created_at end asc,
      case when p_sort = 'date' and p_direction = 'desc' then t.created_at end desc,
      case when p_sort = 'amount' and p_direction = 'asc' then t.amount_minor end asc,
      case when p_sort = 'amount' and p_direction = 'desc' then t.amount_minor end desc,
      case when p_sort = 'payment' and p_direction = 'asc' then t.payment_status end asc nulls last,
      case when p_sort = 'payment' and p_direction = 'desc' then t.payment_status end desc nulls last,
      t.booking_id asc) as position from filtered t
  )
  select jsonb_build_object('total',s.total,'totalPages',s.total_pages,'page',least(p_page,s.total_pages),
    'rows',coalesce((select jsonb_agg(to_jsonb(o) - 'position' - 'needs_attention' order by o.position)
      from ordered o where o.position > (least(p_page,s.total_pages)-1)*20
        and o.position <= least(p_page,s.total_pages)*20),'[]'::jsonb)) into result from stats s;
  return result;
end;
$$;
revoke all on function public.list_admin_payment_transactions(integer,text,text,text,boolean,text,text,text) from public,anon;
grant execute on function public.list_admin_payment_transactions(integer,text,text,text,boolean,text,text,text) to authenticated;
