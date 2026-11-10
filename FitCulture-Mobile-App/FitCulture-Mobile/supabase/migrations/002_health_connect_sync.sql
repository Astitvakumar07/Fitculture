-- Idempotent Health Connect import support. Safe to run after 001_fitculture.sql.
alter table public.activity_sessions
  add column if not exists source text not null default 'fitculture',
  add column if not exists external_record_id text;

alter table public.activity_sessions
  drop constraint if exists activity_sessions_source_check;

alter table public.activity_sessions
  add constraint activity_sessions_source_check
  check (source in ('fitculture', 'health_connect'));

create unique index if not exists activity_sessions_health_connect_record_unique
  on public.activity_sessions(user_id, external_record_id)
  where external_record_id is not null;

create or replace function public.sync_health_connect_activity(
  p_external_record_id text,
  p_activity_type text,
  p_distance_km numeric default null,
  p_steps integer default null,
  p_duration_seconds integer default 0,
  p_calories integer default null,
  p_started_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_rows integer;
  earned_xp integer;
  earned_coins integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if p_external_record_id is null or length(trim(p_external_record_id)) = 0 then
    raise exception 'External record id is required';
  end if;
  if p_activity_type not in ('Steps','Running','Cycling','Swimming','Yoga','Strength') then
    raise exception 'Unsupported activity type';
  end if;

  insert into public.activity_sessions(
    user_id, activity_type, distance_km, steps, duration_seconds, calories,
    source, external_record_id, created_at
  ) values (
    auth.uid(), p_activity_type, p_distance_km, p_steps,
    greatest(0, coalesce(p_duration_seconds, 0)), p_calories,
    'health_connect', p_external_record_id, coalesce(p_started_at, now())
  )
  on conflict (user_id, external_record_id) where external_record_id is not null
  do nothing;

  get diagnostics inserted_rows = row_count;

  if inserted_rows = 0 then
    -- Daily step totals are updated on each sync; imported workouts remain immutable.
    if p_external_record_id like 'steps:%' then
      update public.activity_sessions
      set steps = greatest(0, coalesce(p_steps, 0)),
          created_at = coalesce(p_started_at, created_at)
      where user_id = auth.uid()
        and external_record_id = p_external_record_id
        and source = 'health_connect';
    end if;
    return false;
  end if;

  -- Daily totals improve stats/leaderboards but should not grant XP for a single step.
  if p_external_record_id like 'steps:%' then
    return true;
  end if;

  earned_xp := greatest(25, least(250, 25 + floor(greatest(0, coalesce(p_duration_seconds, 0)) / 60.0)::integer));
  earned_coins := greatest(5, floor(earned_xp / 4.0)::integer);

  update public.profiles
  set xp = xp + earned_xp,
      fitcoins = fitcoins + earned_coins,
      level = greatest(1, floor((xp + earned_xp) / 1000.0)::integer + 1)
  where id = auth.uid();

  insert into public.reward_transactions(user_id, xp_delta, coin_delta, reason)
  values (auth.uid(), earned_xp, earned_coins, 'Health Connect activity: ' || p_activity_type);

  return true;
end;
$$;

revoke all on function public.sync_health_connect_activity(text, text, numeric, integer, integer, integer, timestamptz)
  from public, anon;

grant execute on function public.sync_health_connect_activity(text, text, numeric, integer, integer, integer, timestamptz)
  to authenticated;
