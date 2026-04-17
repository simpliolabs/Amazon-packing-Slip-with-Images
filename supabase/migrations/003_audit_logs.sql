-- ============================================================
-- AUDIT LOGS TABLE (DPP Compliance)
-- Tracks all access to Amazon PII and sensitive operations
-- ============================================================

create table if not exists public.audit_logs (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  details jsonb default '{}'::jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz default now()
);

-- Index for efficient querying
create index if not exists idx_audit_logs_user_id on public.audit_logs(user_id);
create index if not exists idx_audit_logs_action on public.audit_logs(action);
create index if not exists idx_audit_logs_created_at on public.audit_logs(created_at desc);

-- RLS: only admins can view audit logs; service role can insert
alter table public.audit_logs enable row level security;

create policy "Service role can manage audit logs"
  on public.audit_logs for all
  using (auth.role() = 'service_role');

create policy "Admins can view audit logs"
  on public.audit_logs for select
  using (
    exists (
      select 1 from public.user_profiles
      where id = auth.uid() and role = 'admin'
    )
  );

create policy "Authenticated users can insert audit logs"
  on public.audit_logs for insert
  with check (auth.uid() = user_id);

-- Auto-cleanup: delete audit logs older than 90 days
create or replace function trigger_cleanup_old_audit_logs()
returns trigger as $$
begin
  delete from public.audit_logs where created_at < now() - interval '90 days';
  return null;
end;
$$ language plpgsql security definer;

create trigger auto_delete_old_audit_logs
after insert on public.audit_logs
for each statement
execute function trigger_cleanup_old_audit_logs();
