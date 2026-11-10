-- Add required athlete onboarding details and editable profile fields.
-- Run after migrations 001 through 004.

alter table public.profiles
  add column if not exists age integer check (age is null or age between 13 and 120),
  add column if not exists gender text check (gender is null or gender in ('Female','Male','Non-binary','Prefer not to say')),
  add column if not exists height_cm numeric(5,2) check (height_cm is null or height_cm between 80 and 250),
  add column if not exists weight_kg numeric(5,2) check (weight_kg is null or weight_kg between 25 and 400),
  add column if not exists goal text not null default 'general_fitness'
    check (goal in ('weight_loss','weight_gain','maintain_weight','general_fitness'));

create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  metadata jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  age_value integer;
  height_value numeric(5,2);
  weight_value numeric(5,2);
  gender_value text;
  goal_value text;
begin
  if coalesce(metadata->>'age', '') ~ '^[0-9]{1,3}$' then
    age_value := (metadata->>'age')::integer;
    if age_value not between 13 and 120 then age_value := null; end if;
  end if;
  if coalesce(metadata->>'height_cm', '') ~ '^[0-9]{2,3}(\.[0-9]{1,2})?$' then
    height_value := (metadata->>'height_cm')::numeric;
    if height_value not between 80 and 250 then height_value := null; end if;
  end if;
  if coalesce(metadata->>'weight_kg', '') ~ '^[0-9]{2,3}(\.[0-9]{1,2})?$' then
    weight_value := (metadata->>'weight_kg')::numeric;
    if weight_value not between 25 and 400 then weight_value := null; end if;
  end if;
  gender_value := case when metadata->>'gender' in ('Female','Male','Non-binary','Prefer not to say') then metadata->>'gender' else null end;
  goal_value := case when metadata->>'goal' in ('weight_loss','weight_gain','maintain_weight','general_fitness') then metadata->>'goal' else 'general_fitness' end;

  insert into public.profiles(id, full_name, age, gender, height_cm, weight_kg, goal)
  values (new.id, coalesce(nullif(trim(metadata->>'full_name'), ''), 'FitCulture Athlete'), age_value, gender_value, height_value, weight_value, goal_value)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop function if exists public.update_fitculture_profile(text,text,text,text,text);
drop function if exists public.update_fitculture_profile(text,text,text,text,text,integer,text,numeric,numeric,text);
create function public.update_fitculture_profile(
  p_full_name text,
  p_city text,
  p_state text,
  p_country text,
  p_bio text,
  p_age integer,
  p_gender text,
  p_height_cm numeric,
  p_weight_kg numeric,
  p_goal text
)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare result public.profiles;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if length(trim(coalesce(p_full_name, ''))) < 2 then raise exception 'Name must have at least 2 characters'; end if;
  if p_age not between 13 and 120 then raise exception 'Age must be between 13 and 120'; end if;
  if p_gender not in ('Female','Male','Non-binary','Prefer not to say') then raise exception 'Choose a valid gender option'; end if;
  if p_height_cm not between 80 and 250 then raise exception 'Height must be between 80 and 250 cm'; end if;
  if p_weight_kg not between 25 and 400 then raise exception 'Weight must be between 25 and 400 kg'; end if;
  if p_goal not in ('weight_loss','weight_gain','maintain_weight','general_fitness') then raise exception 'Choose a valid fitness goal'; end if;

  update public.profiles
    set full_name = trim(p_full_name),
        city = nullif(trim(coalesce(p_city, '')), ''),
        state = nullif(trim(coalesce(p_state, '')), ''),
        country = nullif(trim(coalesce(p_country, '')), ''),
        bio = left(trim(coalesce(p_bio, '')), 240),
        age = p_age,
        gender = p_gender,
        height_cm = p_height_cm,
        weight_kg = p_weight_kg,
        goal = p_goal,
        updated_at = now()
    where id = auth.uid()
    returning * into result;
  if not found then raise exception 'Profile not found'; end if;
  return result;
end;
$$;

revoke all on function public.update_fitculture_profile(text,text,text,text,text,integer,text,numeric,numeric,text) from public, anon;
grant execute on function public.update_fitculture_profile(text,text,text,text,text,integer,text,numeric,numeric,text) to authenticated;
