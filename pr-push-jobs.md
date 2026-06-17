## Server-side push queue — pushes survive tab close *and* deploys, with a global status bar

> PO: "I Want the full server-side push queue (survives tab close + deploys, global status bar)"

### What your employee does now
1. Open any Ship modal → click **Queue in background** (new button beside Confirm & Ship).
2. The modal closes instantly. A **status bar appears at the bottom of every portal page**: `B0F86LPSHZ · Fit Type — Pushing… 34/147`.
3. Close the tab, navigate anywhere, even let a deploy land mid-push — the push lives on the **server**. Come back any time; the bar shows `Done — 147 accepted` (or exactly what happened).

### How it works
- **One push engine, two delivery modes.** The entire battle-tested push loop moved verbatim out of the route into `src/lib/fba/pushExecutor.ts` (`executePush`). The Ship modal's streaming path and the new job runner call the *same function* — they can never drift. (App Router forbids extra exports from route files, hence the lib move.)
- **Jobs run one at a time** (module promise chain) so total SP-API patch rate stays inside the same 5 rps budget as today. Atomic `queued→running` claim = duplicate kicks are no-ops.
- **Deploy survival is watchdog-on-READ**: every status-bar poll first marks `running` jobs with a stale heartbeat (>120 s) as **interrupted** — with honest guidance: *already-accepted SKUs stayed pushed; Verify on Amazon → "Push just the stale"* — then kicks the oldest still-queued job if nothing is running. The bar's own polling heals the queue after a restart; no cron.
- **30-minute hard ceiling per job** (adversarial self-catch): a hung Amazon call would heartbeat forever and wedge the chain; past the ceiling the job is failed and the queue moves on.
- **Bonus for the streaming path too:** closing the tab mid-stream no longer kills the server loop — `emit()` swallows the disconnect and every SKU still lands.
- The queued job appears in the bar **immediately** after clicking (event-poke, not waiting for the next poll) — the #175 "no notice after action" lesson.

### v1 scope (stated, not hidden)
- Auto Push (bulk details sweep) and "Push just the stale N" still use the streaming modal — they're already background-friendly per #183; queueing them is a follow-up if you want it.
- Queueing the same field twice is allowed: the second job re-validates and Amazon re-accepts the same values — harmless no-op.

### ⚠️ Migration required (1 minute, before first use)
Run in the Supabase SQL editor:

```sql
CREATE TABLE IF NOT EXISTS push_jobs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_asin   TEXT        NOT NULL,
  field         TEXT,
  detail_field  TEXT,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT        NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','failed','interrupted')),
  total         INTEGER     NOT NULL DEFAULT 0,
  accepted      INTEGER     NOT NULL DEFAULT 0,
  failed        INTEGER     NOT NULL DEFAULT 0,
  progress      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  message       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  heartbeat_at  TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_jobs_parent ON push_jobs (parent_asin, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_jobs_status ON push_jobs (status, created_at);

ALTER TABLE push_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_push_jobs" ON push_jobs;
CREATE POLICY "service_role_push_jobs" ON push_jobs FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
```

If you click Queue before running it, the modal shows a friendly "run migration 027" message — nothing breaks.

`tsc` exit 0. Adversarially reviewed (hung-push chain-wedge + poller leak caught and fixed pre-commit).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
