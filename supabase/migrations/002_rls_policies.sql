-- ============================================================
-- RLS POLICIES
-- ============================================================

-- user_profiles: users can read their own profile; admins can read all
create policy "Users can view own profile"
  on public.user_profiles for select
  using (auth.uid() = id);

create policy "Admins can view all profiles"
  on public.user_profiles for select
  using (
    exists (
      select 1 from public.user_profiles
      where id = auth.uid() and role = 'admin'
    )
  );

create policy "Admins can update profiles"
  on public.user_profiles for update
  using (
    exists (
      select 1 from public.user_profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- orders: all authenticated users can read; only service role can insert/update/delete
create policy "Authenticated users can view orders"
  on public.orders for select
  using (auth.role() = 'authenticated');

create policy "Service role can manage orders"
  on public.orders for all
  using (auth.role() = 'service_role');

-- download_logs: authenticated users can insert; admins can view all
create policy "Authenticated users can log downloads"
  on public.download_logs for insert
  with check (auth.uid() = user_id);

create policy "Admins can view download logs"
  on public.download_logs for select
  using (
    exists (
      select 1 from public.user_profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- sync_logs: all authenticated users can view; service role manages
create policy "Authenticated users can view sync logs"
  on public.sync_logs for select
  using (auth.role() = 'authenticated');

create policy "Service role can manage sync logs"
  on public.sync_logs for all
  using (auth.role() = 'service_role');

-- app_settings: only admins can read/write
create policy "Admins can manage settings"
  on public.app_settings for all
  using (
    exists (
      select 1 from public.user_profiles
      where id = auth.uid() and role = 'admin'
    )
  );
