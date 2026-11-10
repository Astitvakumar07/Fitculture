-- User-created challenges and communities.
-- Run after migrations 001, 002 and 003.

alter table public.tournaments
  add column if not exists created_by uuid references public.profiles(id) on delete set null;

create table if not exists public.communities (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 50),
  description text not null default '' check (char_length(description) <= 300),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.community_members (
  community_id uuid not null references public.communities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (community_id, user_id)
);

alter table public.communities enable row level security;
alter table public.community_members enable row level security;

drop policy if exists "read communities" on public.communities;
create policy "read communities" on public.communities for select to authenticated using (true);
drop policy if exists "read community memberships" on public.community_members;
create policy "read community memberships" on public.community_members for select to authenticated using (true);

create or replace function public.create_fitculture_challenge(
  p_title text,
  p_description text,
  p_activity_type text,
  p_duration_days integer default 7
)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if char_length(trim(coalesce(p_title, ''))) < 4 or char_length(trim(p_title)) > 60 then
    raise exception 'Challenge title must be 4–60 characters';
  end if;
  if p_activity_type not in ('Steps','Running','Cycling','Swimming','Yoga','Strength') then
    raise exception 'Choose a supported activity';
  end if;
  if p_duration_days not between 1 and 30 then raise exception 'Duration must be 1–30 days'; end if;

  insert into public.tournaments(title, description, activity_type, starts_at, ends_at, reward_xp, reward_coins, created_by)
  values (trim(p_title), left(trim(coalesce(p_description, '')), 300), p_activity_type,
    now(), now() + make_interval(days => p_duration_days), 100, 25, auth.uid())
  returning id into new_id;

  insert into public.tournament_entries(tournament_id, user_id, score)
  values (new_id, auth.uid(), 0);
  return new_id;
end;
$$;

create or replace function public.create_fitculture_community(p_name text, p_description text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if char_length(trim(coalesce(p_name, ''))) not between 3 and 50 then
    raise exception 'Community name must be 3–50 characters';
  end if;
  insert into public.communities(name, description, created_by)
  values (trim(p_name), left(trim(coalesce(p_description, '')), 300), auth.uid())
  returning id into new_id;
  insert into public.community_members(community_id, user_id) values (new_id, auth.uid());
  return new_id;
end;
$$;

create or replace function public.get_fitculture_communities()
returns table(id uuid, name text, description text, created_at timestamptz, member_count bigint, joined boolean)
language sql security definer set search_path = public as $$
  select c.id, c.name, c.description, c.created_at,
    (select count(*) from public.community_members cm where cm.community_id = c.id),
    exists(select 1 from public.community_members cm where cm.community_id = c.id and cm.user_id = auth.uid())
  from public.communities c
  where auth.uid() is not null
  order by c.created_at desc;
$$;

create or replace function public.join_fitculture_community(p_community_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists(select 1 from public.communities where id = p_community_id) then
    raise exception 'Community not found';
  end if;
  insert into public.community_members(community_id, user_id)
  values (p_community_id, auth.uid()) on conflict do nothing;
end;
$$;

revoke all on function public.create_fitculture_challenge(text,text,text,integer) from public, anon;
revoke all on function public.create_fitculture_community(text,text) from public, anon;
revoke all on function public.get_fitculture_communities() from public, anon;
revoke all on function public.join_fitculture_community(uuid) from public, anon;
grant execute on function public.create_fitculture_challenge(text,text,text,integer) to authenticated;
grant execute on function public.create_fitculture_community(text,text) to authenticated;
grant execute on function public.get_fitculture_communities() to authenticated;
grant execute on function public.join_fitculture_community(uuid) to authenticated;
