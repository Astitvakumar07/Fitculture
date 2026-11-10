-- FitCulture profile editing, challenge scoring and reward redemption.
-- Run after 001_fitculture.sql and 002_health_connect_sync.sql.

alter table public.profiles
  add column if not exists bio text not null default '',
  add column if not exists updated_at timestamptz not null default now();

alter table public.tournament_entries
  add column if not exists reward_claimed_at timestamptz;

alter table public.tournaments
  add column if not exists description text not null default '';
alter table public.tournaments enable row level security;

create table if not exists public.reward_catalog (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null default '',
  icon text not null default '🎁',
  cost integer not null check (cost > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.reward_redemptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  reward_id uuid not null references public.reward_catalog(id),
  cost integer not null check (cost > 0),
  created_at timestamptz not null default now()
);

alter table public.reward_catalog enable row level security;
alter table public.reward_redemptions enable row level security;
drop policy if exists "read active rewards" on public.reward_catalog;
create policy "read active rewards" on public.reward_catalog for select to authenticated using (active);
drop policy if exists "read own redemptions" on public.reward_redemptions;
create policy "read own redemptions" on public.reward_redemptions for select to authenticated using (auth.uid() = user_id);

insert into public.reward_catalog(name, description, icon, cost)
values
  ('Protein coffee', 'A protein coffee reward from the FitCulture store.', '☕', 180),
  ('Runner tee', 'A FitCulture runner tee reward.', '🎽', 650),
  ('5K entry voucher', 'A voucher toward a FitCulture 5K event.', '🎟️', 500),
  ('Gold profile frame', 'Show off your progress with a gold profile frame.', '✨', 300)
on conflict (name) do update set description = excluded.description, icon = excluded.icon, cost = excluded.cost, active = true;

-- Create one genuine weekly challenge for each supported activity if none exists.
insert into public.tournaments(title, activity_type, starts_at, ends_at, reward_xp, reward_coins, description)
select a.title, a.activity_type, now(), now() + interval '7 days', 120, 30, a.description
from (values
  ('Weekly Steps Challenge', 'Steps', 'Accumulate the most steps this week.'),
  ('Weekly Running Challenge', 'Running', 'Cover the most running distance this week.'),
  ('Weekly Cycling Challenge', 'Cycling', 'Cover the most cycling distance this week.'),
  ('Weekly Swimming Challenge', 'Swimming', 'Log the most swimming distance this week.'),
  ('Weekly Yoga Challenge', 'Yoga', 'Complete the most mindful minutes this week.'),
  ('Weekly Strength Challenge', 'Strength', 'Complete the most strength minutes this week.')
) as a(title, activity_type, description)
where not exists (
  select 1 from public.tournaments t
  where t.title = a.title and t.ends_at > now()
);

drop policy if exists "read tournaments" on public.tournaments;
create policy "read tournaments" on public.tournaments for select to authenticated using (true);

create or replace function public.update_fitculture_profile(
  p_full_name text,
  p_city text default null,
  p_state text default null,
  p_country text default null,
  p_bio text default ''
)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare result public.profiles;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if length(trim(coalesce(p_full_name, ''))) < 2 then raise exception 'Name must have at least 2 characters'; end if;
  update public.profiles
    set full_name = trim(p_full_name),
        city = nullif(trim(coalesce(p_city, '')), ''),
        state = nullif(trim(coalesce(p_state, '')), ''),
        country = nullif(trim(coalesce(p_country, '')), ''),
        bio = left(trim(coalesce(p_bio, '')), 240),
        updated_at = now()
    where id = auth.uid()
    returning * into result;
  if not found then raise exception 'Profile not found'; end if;
  return result;
end;
$$;

create or replace function public.get_fitculture_challenges()
returns table(
  id uuid, title text, description text, activity_type text, starts_at timestamptz,
  ends_at timestamptz, reward_xp integer, reward_coins integer,
  participant_count bigint, joined boolean, my_score numeric, reward_claimed boolean
)
language sql security definer set search_path = public as $$
  select t.id, t.title, t.description, t.activity_type, t.starts_at, t.ends_at,
    t.reward_xp, t.reward_coins,
    (select count(*) from public.tournament_entries e where e.tournament_id = t.id),
    exists(select 1 from public.tournament_entries e where e.tournament_id = t.id and e.user_id = auth.uid()),
    coalesce((select e.score from public.tournament_entries e where e.tournament_id = t.id and e.user_id = auth.uid()), 0),
    coalesce((select e.reward_claimed_at is not null from public.tournament_entries e where e.tournament_id = t.id and e.user_id = auth.uid()), false)
  from public.tournaments t
  where auth.uid() is not null and t.ends_at > now() - interval '14 days'
  order by (t.starts_at <= now() and t.ends_at > now()) desc, t.ends_at asc;
$$;

create or replace function public.join_fitculture_challenge(p_tournament_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare challenge public.tournaments;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into challenge from public.tournaments where id = p_tournament_id for share;
  if not found then raise exception 'Challenge not found'; end if;
  if challenge.starts_at > now() or challenge.ends_at <= now() then raise exception 'This challenge is not open for joining'; end if;
  insert into public.tournament_entries(tournament_id, user_id, score)
  values (p_tournament_id, auth.uid(), 0)
  on conflict (tournament_id, user_id) do nothing;
  update public.tournament_entries e set score = coalesce((
    select sum(case when s.activity_type = 'Steps' then coalesce(s.steps,0)::numeric
      else coalesce(s.distance_km, s.duration_seconds / 60.0) end)
    from public.activity_sessions s where s.user_id = auth.uid()
      and s.activity_type = challenge.activity_type and s.created_at >= challenge.starts_at
  ),0) where e.tournament_id = p_tournament_id and e.user_id = auth.uid();
end;
$$;

create or replace function public.refresh_joined_challenge_scores()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.tournament_entries e set score = coalesce((
    select sum(case when s.activity_type = 'Steps' then coalesce(s.steps,0)::numeric
      else coalesce(s.distance_km, s.duration_seconds / 60.0) end)
    from public.activity_sessions s
    where s.user_id = new.user_id and s.activity_type = new.activity_type and s.created_at >= t.starts_at
  ),0)
  from public.tournaments t
  where t.id = e.tournament_id and t.activity_type = new.activity_type
    and e.user_id = new.user_id and t.starts_at <= new.created_at and new.created_at <= t.ends_at;
  return new;
end;
$$;
drop trigger if exists refresh_joined_challenge_scores on public.activity_sessions;
create trigger refresh_joined_challenge_scores
  after insert or update of activity_type, steps, distance_km, duration_seconds, created_at
  on public.activity_sessions for each row execute function public.refresh_joined_challenge_scores();

create or replace function public.claim_fitculture_challenge_reward(p_tournament_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare challenge public.tournaments; my_entry public.tournament_entries; place bigint;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into challenge from public.tournaments where id = p_tournament_id;
  if not found or challenge.ends_at > now() then raise exception 'Challenge is still in progress'; end if;
  select * into my_entry from public.tournament_entries where tournament_id = p_tournament_id and user_id = auth.uid() for update;
  if not found then raise exception 'Join the challenge before claiming a reward'; end if;
  if my_entry.reward_claimed_at is not null then raise exception 'Challenge reward already claimed'; end if;
  if my_entry.score <= 0 then raise exception 'Complete at least one activity in this challenge before claiming'; end if;
  select count(*) + 1 into place from public.tournament_entries e
    where e.tournament_id = p_tournament_id and (e.score > my_entry.score or (e.score = my_entry.score and e.joined_at < my_entry.joined_at));
  update public.profiles set xp = xp + challenge.reward_xp,
    fitcoins = fitcoins + challenge.reward_coins,
    level = greatest(1, floor((xp + challenge.reward_xp) / 1000.0)::integer + 1)
    where id = auth.uid();
  update public.tournament_entries set reward_claimed_at = now()
    where tournament_id = p_tournament_id and user_id = auth.uid();
  insert into public.reward_transactions(user_id, xp_delta, coin_delta, reason)
    values(auth.uid(), challenge.reward_xp, challenge.reward_coins, 'Challenge reward: ' || challenge.title || ' (rank #' || place || ')');
end;
$$;

create or replace function public.redeem_fitculture_reward(p_reward_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare reward public.reward_catalog;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into reward from public.reward_catalog where id = p_reward_id and active for share;
  if not found then raise exception 'This reward is unavailable'; end if;
  update public.profiles set fitcoins = fitcoins - reward.cost where id = auth.uid() and fitcoins >= reward.cost;
  if not found then raise exception 'Not enough FitCoins'; end if;
  insert into public.reward_redemptions(user_id, reward_id, cost) values(auth.uid(), reward.id, reward.cost);
  insert into public.reward_transactions(user_id, xp_delta, coin_delta, reason)
    values(auth.uid(), 0, -reward.cost, 'Reward redeemed: ' || reward.name);
end;
$$;

create or replace function public.claim_daily_bonus()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  update public.profiles set xp = xp + 25, fitcoins = fitcoins + 25,
    level = greatest(1, floor((xp + 25) / 1000.0)::integer + 1),
    last_daily_claim = current_date
    where id = auth.uid() and (last_daily_claim is null or last_daily_claim < current_date);
  if not found then raise exception 'Daily bonus already claimed'; end if;
  insert into public.reward_transactions(user_id, xp_delta, coin_delta, reason)
    values(auth.uid(), 25, 25, 'Daily bonus');
end;
$$;

create or replace function public.complete_activity(
  p_activity_type text,
  p_distance_km numeric default null,
  p_steps integer default null,
  p_duration_seconds integer default 0,
  p_calories integer default null
)
returns void language plpgsql security definer set search_path = public as $$
declare earned_xp integer; earned_coins integer; challenge record;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_activity_type not in ('Steps','Running','Cycling','Swimming','Yoga','Strength') then raise exception 'Unsupported activity type'; end if;
  if coalesce(p_distance_km, 0) < 0 or coalesce(p_steps, 0) < 0 or coalesce(p_duration_seconds, 0) < 0 then raise exception 'Activity values cannot be negative'; end if;
  earned_xp := greatest(25, least(250, 25 + floor(greatest(0, p_duration_seconds) / 60.0)::integer));
  earned_coins := greatest(5, floor(earned_xp / 4.0)::integer);
  insert into public.activity_sessions(user_id, activity_type, distance_km, steps, duration_seconds, calories)
    values(auth.uid(), p_activity_type, p_distance_km, p_steps, greatest(0, coalesce(p_duration_seconds, 0)), greatest(0, p_calories));
  update public.profiles set xp = xp + earned_xp, fitcoins = fitcoins + earned_coins,
    level = greatest(1, floor((xp + earned_xp) / 1000.0)::integer + 1) where id = auth.uid();
  insert into public.reward_transactions(user_id, xp_delta, coin_delta, reason)
    values(auth.uid(), earned_xp, earned_coins, 'Activity completed: ' || p_activity_type);
  for challenge in
    select t.id, t.starts_at, t.activity_type from public.tournaments t
    join public.tournament_entries e on e.tournament_id = t.id and e.user_id = auth.uid()
    where t.activity_type = p_activity_type and now() between t.starts_at and t.ends_at
  loop
    update public.tournament_entries e set score = coalesce((
      select sum(case when s.activity_type = 'Steps' then coalesce(s.steps,0)::numeric
        else coalesce(s.distance_km, s.duration_seconds / 60.0) end)
      from public.activity_sessions s where s.user_id = auth.uid()
        and s.activity_type = challenge.activity_type and s.created_at >= challenge.starts_at
    ),0) where e.tournament_id = challenge.id and e.user_id = auth.uid();
  end loop;
end;
$$;

revoke all on function public.update_fitculture_profile(text,text,text,text,text) from public, anon;
revoke all on function public.get_fitculture_challenges() from public, anon;
revoke all on function public.join_fitculture_challenge(uuid) from public, anon;
revoke all on function public.claim_fitculture_challenge_reward(uuid) from public, anon;
revoke all on function public.redeem_fitculture_reward(uuid) from public, anon;
grant execute on function public.update_fitculture_profile(text,text,text,text,text) to authenticated;
grant execute on function public.get_fitculture_challenges() to authenticated;
grant execute on function public.join_fitculture_challenge(uuid) to authenticated;
grant execute on function public.claim_fitculture_challenge_reward(uuid) to authenticated;
grant execute on function public.redeem_fitculture_reward(uuid) to authenticated;
grant execute on function public.claim_daily_bonus() to authenticated;
grant execute on function public.complete_activity(text,numeric,integer,integer,integer) to authenticated;
