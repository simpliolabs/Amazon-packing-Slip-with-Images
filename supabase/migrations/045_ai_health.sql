-- 045: Site-wide AI-health signal (2026-07-08).
-- WHY: on 2026-07-08 the OpenAI account ran out of credit and the system said NOTHING — every
-- council call failed open to empty, empty content persisted as a successful audit, and the PO
-- found out by watching his bullets vanish. This single-row table is written by the AI routes
-- (DOWN on a hard quota/auth error, OK on the next healthy run — self-healing) and polled by the
-- fba layout's AiHealthBanner so "AI is down — check billing" shows on EVERY page.
create table if not exists ai_health (
  id int primary key default 1 check (id = 1),   -- single row: the one global AI status
  status text not null default 'ok' check (status in ('ok', 'down')),
  kind text,                                      -- 'quota' | 'auth' when down
  message text,
  occurred_at timestamptz,                        -- when the hard failure was recorded
  cleared_at timestamptz,                         -- when the next healthy run cleared it
  updated_at timestamptz not null default now()
);

insert into ai_health (id, status) values (1, 'ok') on conflict (id) do nothing;

alter table ai_health enable row level security;

-- Readable by any signed-in portal user (the banner poll). Writes go through the service-role
-- client in the AI routes only — no authenticated write policy on purpose.
drop policy if exists "ai_health readable by authenticated" on ai_health;
create policy "ai_health readable by authenticated"
  on ai_health for select
  to authenticated
  using (true);
