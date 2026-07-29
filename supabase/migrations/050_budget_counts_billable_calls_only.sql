-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 050 — the keyword-research budget must count BILLABLE calls, not every logged attempt
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- LIVE FAILURE (2026-07-29). `[jungleScoutClient] Monthly budget exhausted` locked out ALL keyword
-- research while Jungle Scout's own dashboard showed the account well inside its 1,000-call plan
-- (PO screenshot + Catalyst usage export: 885 real calls for July). Consequence: `refresh=true`
-- harvested 0 keywords, storeAnalysis's empty-guard correctly returned early, and the listing kept
-- serving a target set computed hours earlier — a silent, total stall of the pipeline with no error
-- surfaced to the seller.
--
-- ROOT CAUSE. `api_usage_this_month.calls_used` was `COUNT(*)` over api_usage_log with NO status
-- filter, so every 4xx/5xx/429 attempt burned a "credit" that Jungle Scout never billed. Our own
-- source already warned about exactly this (jungleScoutClient.ts ~:221: "logApiCall has NO status
-- filter, so an unsupported param 400s and STILL burns a counted credit on every tripping listing,
-- forever"). The guard therefore trips EARLY and, worse, gets earlier every time something fails —
-- a failure mode that tightens itself.
--
-- FIX. Count a call against the budget only when the provider would bill it: a 2xx response. This is
-- a VIEW-only change: both readers (`isWithinBudget` and `getApiUsageStats`, cacheService.ts) select
-- `calls_used` from this view, so ONE definition changes and the guard and the UI meter can never
-- disagree. No application deploy required.
--
-- NULL IS COUNTED AS BILLABLE, deliberately. `response_status` is nullable and pre-existing rows may
-- carry NULL. Excluding them would UNDER-count and risk crossing the 1,000-call plan into overage
-- ($0.05/call); counting them keeps the error in the safe direction. The 950 cap already reserves 50
-- calls of headroom below the plan limit.
--
-- OBSERVABILITY. `calls_logged` and `calls_unbilled` are added so the gap that caused this outage is
-- VISIBLE rather than inferred: if `calls_unbilled` starts climbing, something is failing repeatedly
-- and burning nothing but noise. Existing readers select `calls_used` by name and are unaffected.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW api_usage_this_month AS
SELECT
  provider,
  -- BILLABLE ONLY — this is the number the budget guard and the UI meter both mean by "used".
  COUNT(*) FILTER (
    WHERE response_status IS NULL
       OR (response_status >= 200 AND response_status < 300)
  )::INTEGER AS calls_used,
  -- Every attempt, billable or not (the OLD definition of calls_used — kept for diagnosis).
  COUNT(*)::INTEGER AS calls_logged,
  -- Attempts the provider did not bill. A rising number here is a bug, not usage.
  COUNT(*) FILTER (
    WHERE response_status IS NOT NULL
      AND (response_status < 200 OR response_status >= 300)
  )::INTEGER AS calls_unbilled,
  DATE_TRUNC('month', NOW()) AS month_start
FROM api_usage_log
WHERE called_at >= DATE_TRUNC('month', NOW())
GROUP BY provider;

COMMENT ON VIEW api_usage_this_month IS
  'Calls used this calendar month per provider. calls_used counts BILLABLE (2xx or unknown-status) '
  'calls only — migration 050, after non-2xx attempts falsely exhausted the 950-call research budget '
  'on 2026-07-29 while the provider account was well inside its 1,000-call plan. calls_logged is '
  'every attempt; calls_unbilled is the difference and should stay near zero.';

NOTIFY pgrst, 'reload schema';
