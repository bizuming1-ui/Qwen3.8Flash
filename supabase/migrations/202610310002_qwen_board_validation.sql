-- Reject missing fields and invalid numbers without relying on SQL expression evaluation order.
create or replace function public.qwen_board_set(p_field text, p_value text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare b public.qwen_board_state; n bigint; v text; changed boolean := false;
begin
  if p_field = 'current' then raise exception 'READ_ONLY'; end if;
  if p_field is null or p_field not in ('order_no','product','total','now') then raise exception 'BAD_FIELD'; end if;
  if p_field = 'total' and not public.qwen_board_is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into strict b from public.qwen_board_state where id for update;
  if p_field in ('order_no','product') then
    v := regexp_replace(coalesce(p_value,''), '[[:cntrl:]]', '', 'g');
    while octet_length(v) > 200 loop v := left(v, length(v)-1); end loop;
    if p_field='order_no' then changed := b.order_no <> v; b.order_no := v;
    else changed := b.product <> v; b.product := v; end if;
  else
    if p_value is null or p_value !~ '^[0-9]{1,13}$' then raise exception 'BAD_NUMBER'; end if;
    if p_value::numeric > 1000000000000 then raise exception 'BAD_NUMBER'; end if;
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
