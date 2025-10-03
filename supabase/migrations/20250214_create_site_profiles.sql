create table if not exists public.site_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  site_url text not null,
  raw_text text not null,
  profile jsonb not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists site_profiles_user_id_key on public.site_profiles(user_id);
