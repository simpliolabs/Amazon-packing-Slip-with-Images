-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- User profiles table (extends Supabase auth.users)
create table public.user_profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text not null,
  full_name text,
  role text not null default 'packer' check (role in ('admin', 'packer')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Orders table
create table public.orders (
  id text primary key,
  purchase_date timestamptz not null,
  buyer_name text,
  buyer_email text,
  ship_to jsonb,
  order_items jsonb default '[]'::jsonb,
  fulfillment_channel text default 'MFN',
  order_status text,
  raw_data jsonb,
  synced_at timestamptz default now(),
  created_at timestamptz default now()
);

-- Download logs table
create table public.download_logs (
  id uuid default uuid_generate_v4() primary key,
  order_id text references public.orders(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  download_type text not null check (download_type in ('single', 'bulk')),
  created_at timestamptz default now()
);

-- Sync log table
create table public.sync_logs (
  id uuid default uuid_generate_v4() primary key,
  started_at timestamptz default now(),
  completed_at timestamptz,
  orders_synced integer default 0,
  status text default 'running' check (status in ('running', 'success', 'error')),
  error_message text
);

-- App settings table (for storing Amazon credentials etc)
create table public.app_settings (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

-- Auto-cleanup trigger function: delete orders older than 7 days
create or replace function trigger_cleanup_old_orders()
returns trigger as $$
begin
  delete from public.orders where purchase_date < now() - interval '7 days';
  return null;
end;
$$ language plpgsql security definer;

create trigger auto_delete_old_orders
after insert on public.orders
for each statement
execute function trigger_cleanup_old_orders();

-- Function to auto-create user profile on signup
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.user_profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'role', 'packer')
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function handle_new_user();

-- Updated_at trigger
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger update_user_profiles_updated_at
before update on public.user_profiles
for each row execute function update_updated_at_column();
