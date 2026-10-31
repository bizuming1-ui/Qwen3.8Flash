-- 分享地址可能带查询参数；保留完整 URL，同时拒绝地址中的用户名和密码。
create or replace function public.qwen_board_set_share(p_url text) returns text
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not public.qwen_board_is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_url is not null and p_url <> '' and
    (length(p_url)>1024 or p_url !~* '^https?://[^/@[:space:]]+([/?#][^[:space:]]*)?$')
    then raise exception 'BAD_URL'; end if;
  update public.qwen_board_settings set share_url=nullif(p_url,'') where id;
  return public.qwen_board_get_share();
end $$;
