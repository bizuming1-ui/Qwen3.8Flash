-- 与项目中已有的 orders、production_events、app_settings 完全隔离。
-- 数据库是云端唯一权威；所有操作锁定同一行，并由 CHECK 兜底保证累计数不超总数。
create table public.qwen_board_state (
  id boolean primary key default true check (id),
  rev bigint not null default 0 check (rev >= 0),
  order_no text not null default '' check (octet_length(order_no) <= 200),
  product text not null default '' check (octet_length(product) <= 200),
  total bigint not null default 0 check (total between 0 and 1000000000000),
  current_count bigint not null default 0 check (current_count between 0 and 1000000000000),
  now_count bigint not null default 0 check (now_count between 0 and 1000000000000),
  last_action text not null default 'SET',
  constraint qwen_board_current_not_over_total check (current_count <= total)
);
insert into public.qwen_board_state (id) values (true);

create table public.qwen_board_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table public.qwen_board_settings (
  id boolean primary key default true check (id),
  share_url text
);
insert into public.qwen_board_settings (id) values (true);

create table public.qwen_board_events (
  id bigint generated always as identity primary key,
  rev bigint not null,
  kind text not null,
  request_id uuid unique,
  requested bigint,
  delta bigint not null default 0,
  total bigint not null,
  current_count bigint not null,
  now_count bigint not null,
  order_no text not null,
  product text not null,
  actor uuid,
  created_at timestamptz not null default now(),
  snapshot jsonb not null
);
create index qwen_board_events_created_idx on public.qwen_board_events (created_at desc);

alter table public.qwen_board_state enable row level security;
alter table public.qwen_board_admins enable row level security;
alter table public.qwen_board_settings enable row level security;
alter table public.qwen_board_events enable row level security;
revoke all on public.qwen_board_state, public.qwen_board_admins,
  public.qwen_board_settings, public.qwen_board_events from public, anon, authenticated;
grant select on public.qwen_board_state to anon, authenticated;
create policy qwen_board_read_state on public.qwen_board_state for select to anon, authenticated using (true);

create function public.qwen_board_is_admin() returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp
as $$ select exists(select 1 from public.qwen_board_admins where user_id = auth.uid()); $$;

create function public.qwen_board_pack(b public.qwen_board_state) returns jsonb
language sql immutable set search_path = pg_catalog, public, pg_temp
as $$ select jsonb_build_object('rev',b.rev,'state',jsonb_build_object(
  'order_no',b.order_no,'product',b.product,'total',b.total,
  'current',b.current_count,'now',b.now_count)); $$;

create function public.qwen_board_log(b public.qwen_board_state, k text, d bigint, req uuid, amount bigint)
returns void language sql security definer set search_path = pg_catalog, public, pg_temp
as $$ insert into public.qwen_board_events
  (rev,kind,request_id,requested,delta,total,current_count,now_count,order_no,product,actor,snapshot)
  values (b.rev,k,req,amount,d,b.total,b.current_count,b.now_count,b.order_no,b.product,
    auth.uid(),public.qwen_board_pack(b)); $$;

create function public.qwen_board_set(p_field text, p_value text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare b public.qwen_board_state; n bigint; v text; changed boolean := false;
begin
  if p_field = 'current' then raise exception 'READ_ONLY'; end if;
  if p_field not in ('order_no','product','total','now') then raise exception 'BAD_FIELD'; end if;
  if p_field = 'total' and not public.qwen_board_is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into strict b from public.qwen_board_state where id for update;
  if p_field in ('order_no','product') then
    v := regexp_replace(coalesce(p_value,''), '[[:cntrl:]]', '', 'g');
    while octet_length(v) > 200 loop v := left(v, length(v)-1); end loop;
    if p_field='order_no' then changed := b.order_no <> v; b.order_no := v;
    else changed := b.product <> v; b.product := v; end if;
  else
    if p_value is null or p_value !~ '^[0-9]{1,13}$' or p_value::numeric > 1000000000000
      then raise exception 'BAD_NUMBER'; end if;
    n := p_value::bigint;
    if p_field='total' then
      if n < b.current_count then raise exception 'TOTAL_TOO_SMALL'; end if;
      changed := b.total <> n; b.total := n;
    else changed := b.now_count <> n; b.now_count := n; end if;
  end if;
  if changed then
    update public.qwen_board_state set rev=rev+1,order_no=b.order_no,product=b.product,
      total=b.total,now_count=b.now_count,last_action='SET' where id returning * into b;
    perform public.qwen_board_log(b,'SET',0,null,null);
  end if;
  return public.qwen_board_pack(b);
end $$;

create function public.qwen_board_confirm(p_amount bigint, p_request uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare b public.qwen_board_state; e public.qwen_board_events;
begin
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000000 or p_request is null
    then raise exception 'BAD_AMOUNT'; end if;
  -- 重试同一请求不会重复累计；不同设备的确认按行锁顺序串行化。
  perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
  select * into e from public.qwen_board_events where request_id=p_request;
  if found then
    if e.requested <> p_amount then raise exception 'REQUEST_MISMATCH'; end if;
    return e.snapshot || jsonb_build_object('delta',e.delta);
  end if;
  select * into strict b from public.qwen_board_state where id for update;
  if p_amount > b.total - b.current_count then raise exception 'EXCEEDS_TOTAL'; end if;
  update public.qwen_board_state set current_count=current_count+p_amount,now_count=0,
    rev=rev+1,last_action='COMMIT' where id returning * into b;
  perform public.qwen_board_log(b,'COMMIT',p_amount,p_request,p_amount);
  return public.qwen_board_pack(b) || jsonb_build_object('delta',p_amount);
end $$;

create function public.qwen_board_reset() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare b public.qwen_board_state;
begin
  if not public.qwen_board_is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  update public.qwen_board_state set rev=rev+1,order_no='',product='',total=0,current_count=0,
    now_count=0,last_action='RESET' where id returning * into b;
  perform public.qwen_board_log(b,'RESET',0,null,null);
  return public.qwen_board_pack(b);
end $$;

create function public.qwen_board_get_share() returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp
as $$ select share_url from public.qwen_board_settings where id; $$;

create function public.qwen_board_set_share(p_url text) returns text
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not public.qwen_board_is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_url is not null and p_url <> '' and
    (length(p_url)>1024 or p_url !~* '^https?://[^[:space:]]+$') then raise exception 'BAD_URL'; end if;
  update public.qwen_board_settings set share_url=nullif(rtrim(coalesce(p_url,''),'/'),'') where id;
  return public.qwen_board_get_share();
end $$;

create function public.qwen_board_history(p_limit integer default 50) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object('ok',true,'total',
    (select count(*) from public.qwen_board_events where kind='COMMIT'),
    'items',coalesce((select jsonb_agg(to_jsonb(x) order by x.rev desc) from
      (select (extract(epoch from created_at)*1000)::bigint as ts,rev,delta,total,
        current_count as current,order_no,product
       from public.qwen_board_events where kind='COMMIT' order by rev desc
       limit least(greatest(coalesce(p_limit,50),0),10000)) x), '[]'::jsonb));
$$;

create function public.qwen_board_stats() returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object('ok',true,'records',count(*),
    'commits',count(*) filter (where kind='COMMIT'),
    'produced_total',coalesce(sum(delta) filter (where kind='COMMIT'),0),
    'corrupt_lines',0,
    'rate_per_min',round(coalesce(sum(delta) filter (where kind='COMMIT' and created_at >= now()-interval '10 minutes'),0)/10.0,2),
    'last_commit',(select jsonb_build_object('ts',(extract(epoch from created_at)*1000)::bigint,
      'rev',rev,'delta',delta,'total',total,'current',current_count,'order_no',order_no,'product',product)
      from public.qwen_board_events where kind='COMMIT' order by rev desc limit 1))
    from public.qwen_board_events;
$$;

-- helper 绝不向访客暴露，用户只能调用校验过的 RPC。
revoke execute on function public.qwen_board_pack(public.qwen_board_state),
  public.qwen_board_log(public.qwen_board_state,text,bigint,uuid,bigint) from public, anon, authenticated;
revoke execute on function public.qwen_board_is_admin(), public.qwen_board_set(text,text),
  public.qwen_board_confirm(bigint,uuid), public.qwen_board_reset(), public.qwen_board_get_share(),
  public.qwen_board_set_share(text), public.qwen_board_history(integer), public.qwen_board_stats() from public;
grant execute on function public.qwen_board_is_admin(), public.qwen_board_set(text,text),
  public.qwen_board_confirm(bigint,uuid), public.qwen_board_reset(), public.qwen_board_get_share(),
  public.qwen_board_set_share(text), public.qwen_board_history(integer), public.qwen_board_stats() to anon, authenticated;

-- 为新表增加广播，不改变已有 publication 中的其他表。
alter publication supabase_realtime add table public.qwen_board_state;
