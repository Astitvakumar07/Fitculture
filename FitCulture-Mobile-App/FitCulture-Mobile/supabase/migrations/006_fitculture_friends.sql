-- Friend requests and friend discovery.
-- Run after migrations 001 through 005.

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> recipient_id)
);

create unique index if not exists friend_requests_one_pair
  on public.friend_requests (least(requester_id, recipient_id), greatest(requester_id, recipient_id));
create index if not exists friend_requests_recipient_status
  on public.friend_requests (recipient_id, status, created_at desc);

alter table public.friend_requests enable row level security;
drop policy if exists "read own friend requests" on public.friend_requests;
create policy "read own friend requests" on public.friend_requests
  for select to authenticated using (auth.uid() = requester_id or auth.uid() = recipient_id);

create or replace function public.search_fitculture_users(p_query text)
returns table(user_id uuid, full_name text, city text, relationship text)
language sql security definer set search_path = public as $$
  select p.id, p.full_name, p.city,
    case
      when fr.status = 'accepted' then 'friends'
      when fr.status = 'pending' and fr.requester_id = auth.uid() then 'sent'
      when fr.status = 'pending' and fr.recipient_id = auth.uid() then 'received'
      else 'none'
    end
  from public.profiles p
  left join public.friend_requests fr on
    least(fr.requester_id, fr.recipient_id) = least(p.id, auth.uid()) and
    greatest(fr.requester_id, fr.recipient_id) = greatest(p.id, auth.uid())
  where auth.uid() is not null and p.id <> auth.uid()
    and char_length(trim(coalesce(p_query, ''))) >= 2
    and p.full_name ilike '%' || trim(p_query) || '%'
  order by p.full_name
  limit 25;
$$;

create or replace function public.get_fitculture_friend_connections()
returns table(request_id uuid, user_id uuid, full_name text, city text, status text, direction text, created_at timestamptz)
language sql security definer set search_path = public as $$
  select fr.id, p.id, p.full_name, p.city, fr.status,
    case when fr.status = 'accepted' then 'friend'
      when fr.recipient_id = auth.uid() then 'incoming' else 'outgoing' end,
    fr.created_at
  from public.friend_requests fr
  join public.profiles p on p.id = case when fr.requester_id = auth.uid() then fr.recipient_id else fr.requester_id end
  where auth.uid() is not null and (fr.requester_id = auth.uid() or fr.recipient_id = auth.uid())
    and fr.status in ('pending','accepted')
  order by (fr.status = 'pending' and fr.recipient_id = auth.uid()) desc, fr.created_at desc;
$$;

create or replace function public.send_fitculture_friend_request(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare existing_request public.friend_requests;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_user_id is null or p_user_id = auth.uid() then raise exception 'Choose another FitCulture user'; end if;
  if not exists(select 1 from public.profiles where id = p_user_id) then raise exception 'User not found'; end if;

  select * into existing_request from public.friend_requests
    where least(requester_id, recipient_id) = least(auth.uid(), p_user_id)
      and greatest(requester_id, recipient_id) = greatest(auth.uid(), p_user_id)
    for update;
  if found then
    if existing_request.status = 'accepted' then raise exception 'You are already friends'; end if;
    if existing_request.status = 'pending' and existing_request.requester_id = auth.uid() then raise exception 'Friend request already sent'; end if;
    if existing_request.status = 'pending' and existing_request.recipient_id = auth.uid() then
      update public.friend_requests set status = 'accepted', responded_at = now() where id = existing_request.id;
      return;
    end if;
    update public.friend_requests set requester_id = auth.uid(), recipient_id = p_user_id,
      status = 'pending', created_at = now(), responded_at = null where id = existing_request.id;
  else
    insert into public.friend_requests(requester_id, recipient_id) values (auth.uid(), p_user_id);
  end if;
end;
$$;

create or replace function public.respond_fitculture_friend_request(p_request_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  update public.friend_requests
    set status = case when p_accept then 'accepted' else 'declined' end,
        responded_at = now()
    where id = p_request_id and recipient_id = auth.uid() and status = 'pending';
  if not found then raise exception 'Friend request is no longer available'; end if;
end;
$$;

revoke all on function public.search_fitculture_users(text) from public, anon;
revoke all on function public.get_fitculture_friend_connections() from public, anon;
revoke all on function public.send_fitculture_friend_request(uuid) from public, anon;
revoke all on function public.respond_fitculture_friend_request(uuid,boolean) from public, anon;
grant execute on function public.search_fitculture_users(text) to authenticated;
grant execute on function public.get_fitculture_friend_connections() to authenticated;
grant execute on function public.send_fitculture_friend_request(uuid) to authenticated;
grant execute on function public.respond_fitculture_friend_request(uuid,boolean) to authenticated;
