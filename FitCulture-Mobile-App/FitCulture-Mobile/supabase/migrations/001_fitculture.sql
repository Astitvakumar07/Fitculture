create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default 'FitCulture Athlete',
  city text,
  state text,
  country text,
  level integer not null default 1 check (level >= 1),
  xp integer not null default 0 check (xp >= 0),
  fitcoins integer not null default 0 check (fitcoins >= 0),
  last_daily_claim date,
  created_at timestamptz not null default now()
);

create table if not exists public.activity_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  activity_type text not null check (activity_type in ('Steps','Running','Cycling','Swimming','Yoga','Strength')),
  distance_km numeric(9,3) check (distance_km is null or distance_km >= 0),
  steps integer check (steps is null or steps >= 0),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  calories integer check (calories is null or calories >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  activity_type text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reward_xp integer not null default 100,
  reward_coins integer not null default 25,
  check (ends_at > starts_at)
);

create table if not exists public.tournament_entries (
  tournament_id uuid references public.tournaments(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  score numeric not null default 0,
  joined_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

create table if not exists public.reward_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  xp_delta integer not null default 0,
  coin_delta integer not null default 0,
  reason text not null,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.activity_sessions enable row level security;
alter table public.tournament_entries enable row level security;
alter table public.reward_transactions enable row level security;

-- Drop existing policies if re-running to avoid duplicate policy errors
drop policy if exists "read own profile" on public.profiles;
drop policy if exists "update own profile" on public.profiles;
drop policy if exists "read own sessions" on public.activity_sessions;
drop policy if exists "read own transactions" on public.reward_transactions;
drop policy if exists "read own entries" on public.tournament_entries;
drop policy if exists "join own entry" on public.tournament_entries;

create policy "read own profile" on public.profiles for select using (auth.uid() = id);
create policy "update own profile" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "read own sessions" on public.activity_sessions for select using (auth.uid() = user_id);
create policy "read own transactions" on public.reward_transactions for select using (auth.uid() = user_id);
create policy "read own entries" on public.tournament_entries for select using (auth.uid() = user_id);
create policy "join own entry" on public.tournament_entries for insert with check (auth.uid() = user_id);

create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', 'FitCulture Athlete'))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_profile_for_new_user();

create or replace function public.complete_activity(
  p_activity_type text,
  p_distance_km numeric default null,
  p_steps integer default null,
  p_duration_seconds integer default 0,
  p_calories integer default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  earned_xp int;
  earned_coins int;
  new_xp int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  earned_xp := greatest(25, least(250, 25 + floor(p_duration_seconds / 60.0)::int));
  earned_coins := greatest(5, floor(earned_xp / 4.0)::int);

  insert into activity_sessions(user_id, activity_type, distance_km, steps, duration_seconds, calories)
  values (auth.uid(), p_activity_type, p_distance_km, p_steps, p_duration_seconds, p_calories);

  update profiles
  set xp = xp + earned_xp,
      fitcoins = fitcoins + earned_coins,
      level = greatest(1, floor((xp + earned_xp) / 1000.0)::int + 1)
  where id = auth.uid()
  returning xp into new_xp;

  insert into reward_transactions(user_id, xp_delta, coin_delta, reason)
  values (auth.uid(), earned_xp, earned_coins, 'Activity completed: ' || p_activity_type);
end;
$$;

create or replace function public.claim_daily_bonus()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if exists(select 1 from profiles where id = auth.uid() and last_daily_claim = current_date) then
    raise exception 'Daily bonus already claimed';
  end if;

  update profiles
  set xp = xp + 25,
      fitcoins = fitcoins + 25,
      level = greatest(1, floor((xp + 25) / 1000.0)::int + 1),
      last_daily_claim = current_date
  where id = auth.uid();

  insert into reward_transactions(user_id, xp_delta, coin_delta, reason)
  values (auth.uid(), 25, 25, 'Daily bonus');
end;
$$;

create or replace function public.get_leaderboard(p_activity_type text, p_scope text default 'city')
returns table(user_id uuid, full_name text, location text, score numeric)
language sql security definer set search_path = public as $$
  with me as (
    select city, state, country from public.profiles where id = auth.uid() limit 1
  ),
  scores as (
    select
      a.user_id,
      p.full_name,
      p.city,
      p.state,
      p.country,
      sum(
        case
          when p_activity_type = 'Steps' then coalesce(a.steps, 0)
          else coalesce(a.distance_km, a.duration_seconds / 60.0)
        end
      )::numeric as score
    from public.activity_sessions a
    join public.profiles p on p.id = a.user_id
    where a.activity_type = p_activity_type
      and a.created_at >= date_trunc('week', now())
    group by a.user_id, p.full_name, p.city, p.state, p.country
  )
  select
    s.user_id,
    s.full_name,
    case lower(p_scope)
      when 'area' then coalesce(s.city, 'Your area')
      when 'state' then coalesce(s.state, 'Your state')
      when 'country' then coalesce(s.country, 'Your country')
      else coalesce(s.city, 'Your city')
    end as location,
    s.score
  from scores s
  left join me on true
  where
    (lower(p_scope) = 'country' and (me.country is null or s.country = me.country))
    or (lower(p_scope) = 'state' and (me.state is null or s.state = me.state))
    or (lower(p_scope) in ('city', 'area') and (me.city is null or s.city = me.city))
    or (me.city is null and me.state is null and me.country is null)
  order by s.score desc
  limit 50;
$$;

grant execute on function public.complete_activity(text, numeric, integer, integer, integer) to authenticated;
grant execute on function public.claim_daily_bonus() to authenticated;
grant execute on function public.get_leaderboard(text, text) to authenticated;
