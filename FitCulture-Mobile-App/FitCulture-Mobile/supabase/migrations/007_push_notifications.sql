-- Stores Expo push tokens per authenticated user and device.
create table if not exists public.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expo_push_token text not null,
  platform text not null check (platform in ('ios', 'android')),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists push_devices_user_id on public.push_devices(user_id);
create unique index if not exists push_devices_user_token on public.push_devices(user_id, expo_push_token);
alter table public.push_devices enable row level security;

drop policy if exists "users manage own push devices" on public.push_devices;
create policy "users manage own push devices" on public.push_devices
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.push_devices to authenticated;

-- Prevents duplicate pushes when an event request is retried by a phone.
create table if not exists public.push_notification_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  event_id text not null,
  sent_at timestamptz not null default now(),
  unique (actor_id, event_type, event_id)
);
alter table public.push_notification_events enable row level security;
revoke all on public.push_notification_events from anon, authenticated;
