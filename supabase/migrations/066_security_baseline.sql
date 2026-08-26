-- 066_security_baseline.sql
--
-- CONSOLIDATES the four security migrations applied to the live database BY HAND
-- (Supabase SQL editor) on 2026-08-25/26 that were never committed as files:
--   066  RLS on world-readable/writable tables
--   067  policies named `service_role_*` that actually granted PUBLIC access
--   068  login_attempts -- its policy is named "Service role can manage login_attempts",
--        so 067's name-convention match missed it
--   069  views -> security_invoker; function search_path pinned
--
-- This file is NOT reconstructed from memory. Every statement below was EMITTED BY
-- POSTGRES from the live catalog (pg_policies / pg_class.reloptions / pg_proc.proconfig)
-- on 2026-08-26, so it reproduces the posture the database actually has.
--
-- Idempotent, safe to re-run: ENABLE RLS is a no-op when already on; every policy is
-- DROP ... IF EXISTS before CREATE; ALTER VIEW/FUNCTION ... SET is declarative; REVOKE is
-- a no-op when the grant is already absent.
--
-- ON THE 13 TABLES WITH RLS AND NO POLICY (ads_*, blank_specs, blank_assignments,
-- blank_family_overrides, listing_health, listing_seo_scores, listing_seo_recommendations,
-- product_identity, sku_sales_analytics): that is INTENTIONAL AND CORRECT. RLS with zero
-- policies denies anon and authenticated entirely; service_role bypasses RLS, and every
-- app read of these tables is server-side on the service-role client (verified 2026-08-26:
-- zero client components query them). Do NOT "fix" this by adding permissive policies.

-- ---- 1. Row Level Security --------------------------------------------------
ALTER TABLE public.ads_ad_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ads_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ads_keyword_perf ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ads_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ads_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asin_traffic ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blank_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blank_family_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blank_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.download_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.excess_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fba_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fba_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fba_work_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_push_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_rank_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_seed_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_share_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_outcome_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_rank_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_score_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_seo_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_seo_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_asin_rollup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pt_schema_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_heal_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_verification_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sku_sales_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- ---- 2. Policies ------------------------------------------------------------
-- The 067/068 fix: these were named service_role_* / "Service role can manage ..." but
-- were granted TO public, i.e. to anon. They are now scoped TO service_role. Policies
-- still shown TO public below are safe -- their USING clause itself tests
-- auth.role() / auth.uid().

DROP POLICY IF EXISTS "Admins can manage settings" ON public.app_settings;
CREATE POLICY "Admins can manage settings" ON public.app_settings AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'admin'::text)))));

DROP POLICY IF EXISTS "Admins can update profiles" ON public.user_profiles;
CREATE POLICY "Admins can update profiles" ON public.user_profiles AS PERMISSIVE FOR UPDATE TO public USING ((get_my_role() = 'admin'::text));

DROP POLICY IF EXISTS "Admins can view all profiles" ON public.user_profiles;
CREATE POLICY "Admins can view all profiles" ON public.user_profiles AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = id) OR (get_my_role() = 'admin'::text)));

DROP POLICY IF EXISTS "Admins can view audit logs" ON public.audit_logs;
CREATE POLICY "Admins can view audit logs" ON public.audit_logs AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'admin'::text)))));

DROP POLICY IF EXISTS "Admins can view download logs" ON public.download_logs;
CREATE POLICY "Admins can view download logs" ON public.download_logs AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'admin'::text)))));

DROP POLICY IF EXISTS "Admins full access to work log" ON public.fba_work_log;
CREATE POLICY "Admins full access to work log" ON public.fba_work_log AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'admin'::text)))));

DROP POLICY IF EXISTS "Authenticated read catalog_products" ON public.catalog_products;
CREATE POLICY "Authenticated read catalog_products" ON public.catalog_products AS PERMISSIVE FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated read fba_inventory" ON public.fba_inventory;
CREATE POLICY "Authenticated read fba_inventory" ON public.fba_inventory AS PERMISSIVE FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated users can log downloads" ON public.download_logs;
CREATE POLICY "Authenticated users can log downloads" ON public.download_logs AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Authenticated users can read excess_inventory" ON public.excess_inventory;
CREATE POLICY "Authenticated users can read excess_inventory" ON public.excess_inventory AS PERMISSIVE FOR SELECT TO public USING ((auth.role() = 'authenticated'::text));

DROP POLICY IF EXISTS "Authenticated users can read fba_notifications" ON public.fba_notifications;
CREATE POLICY "Authenticated users can read fba_notifications" ON public.fba_notifications AS PERMISSIVE FOR SELECT TO public USING ((auth.role() = 'authenticated'::text));

DROP POLICY IF EXISTS "Authenticated users can update excess_inventory" ON public.excess_inventory;
CREATE POLICY "Authenticated users can update excess_inventory" ON public.excess_inventory AS PERMISSIVE FOR UPDATE TO public USING ((auth.role() = 'authenticated'::text)) WITH CHECK ((auth.role() = 'authenticated'::text));

DROP POLICY IF EXISTS "Authenticated users can update fba_notifications" ON public.fba_notifications;
CREATE POLICY "Authenticated users can update fba_notifications" ON public.fba_notifications AS PERMISSIVE FOR UPDATE TO public USING ((auth.role() = 'authenticated'::text)) WITH CHECK ((auth.role() = 'authenticated'::text));

DROP POLICY IF EXISTS "Authenticated users can view orders" ON public.orders;
CREATE POLICY "Authenticated users can view orders" ON public.orders AS PERMISSIVE FOR SELECT TO public USING ((auth.role() = 'authenticated'::text));

DROP POLICY IF EXISTS "Authenticated users can view sync logs" ON public.sync_logs;
CREATE POLICY "Authenticated users can view sync logs" ON public.sync_logs AS PERMISSIVE FOR SELECT TO public USING ((auth.role() = 'authenticated'::text));

DROP POLICY IF EXISTS "Packers can insert their own work log entries" ON public.fba_work_log;
CREATE POLICY "Packers can insert their own work log entries" ON public.fba_work_log AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((logged_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = ANY (ARRAY['admin'::text, 'packer'::text])))))));

DROP POLICY IF EXISTS "Packers can read all work log entries" ON public.fba_work_log;
CREATE POLICY "Packers can read all work log entries" ON public.fba_work_log AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = ANY (ARRAY['admin'::text, 'packer'::text]))))));

DROP POLICY IF EXISTS "Packers can update their own work log entries" ON public.fba_work_log;
CREATE POLICY "Packers can update their own work log entries" ON public.fba_work_log AS PERMISSIVE FOR UPDATE TO authenticated USING (((logged_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = ANY (ARRAY['admin'::text, 'packer'::text]))))))) WITH CHECK ((logged_by = auth.uid()));

DROP POLICY IF EXISTS "Service role can manage audit logs" ON public.audit_logs;
CREATE POLICY "Service role can manage audit logs" ON public.audit_logs AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Service role can manage login_attempts" ON public.login_attempts;
CREATE POLICY "Service role can manage login_attempts" ON public.login_attempts AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can manage orders" ON public.orders;
CREATE POLICY "Service role can manage orders" ON public.orders AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Service role can manage sync logs" ON public.sync_logs;
CREATE POLICY "Service role can manage sync logs" ON public.sync_logs AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Service role full access catalog_products" ON public.catalog_products;
CREATE POLICY "Service role full access catalog_products" ON public.catalog_products AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access fba_inventory" ON public.fba_inventory;
CREATE POLICY "Service role full access fba_inventory" ON public.fba_inventory AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access to excess_inventory" ON public.excess_inventory;
CREATE POLICY "Service role full access to excess_inventory" ON public.excess_inventory AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Service role full access to fba_notifications" ON public.fba_notifications;
CREATE POLICY "Service role full access to fba_notifications" ON public.fba_notifications AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Users can view own profile" ON public.user_profiles;
CREATE POLICY "Users can view own profile" ON public.user_profiles AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = id));

DROP POLICY IF EXISTS "ai_health readable by authenticated" ON public.ai_health;
CREATE POLICY "ai_health readable by authenticated" ON public.ai_health AS PERMISSIVE FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS keyword_push_log_auth_read ON public.keyword_push_log;
CREATE POLICY keyword_push_log_auth_read ON public.keyword_push_log AS PERMISSIVE FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS keyword_push_log_service_all ON public.keyword_push_log;
CREATE POLICY keyword_push_log_service_all ON public.keyword_push_log AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS listing_change_log_auth_read ON public.listing_change_log;
CREATE POLICY listing_change_log_auth_read ON public.listing_change_log AS PERMISSIVE FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS listing_change_log_service_all ON public.listing_change_log;
CREATE POLICY listing_change_log_service_all ON public.listing_change_log AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS listing_claims_auth_read ON public.listing_claims;
CREATE POLICY listing_claims_auth_read ON public.listing_claims AS PERMISSIVE FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS listing_claims_service_all ON public.listing_claims;
CREATE POLICY listing_claims_service_all ON public.listing_claims AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS listing_content_select_authenticated ON public.listing_content;
CREATE POLICY listing_content_select_authenticated ON public.listing_content AS PERMISSIVE FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS listing_outcome_state_auth_read ON public.listing_outcome_state;
CREATE POLICY listing_outcome_state_auth_read ON public.listing_outcome_state AS PERMISSIVE FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS listing_outcome_state_service_all ON public.listing_outcome_state;
CREATE POLICY listing_outcome_state_service_all ON public.listing_outcome_state AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS listing_score_history_auth_read ON public.listing_score_history;
CREATE POLICY listing_score_history_auth_read ON public.listing_score_history AS PERMISSIVE FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS listing_score_history_service_all ON public.listing_score_history;
CREATE POLICY listing_score_history_service_all ON public.listing_score_history AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS phr_auth_read ON public.push_heal_rules;
CREATE POLICY phr_auth_read ON public.push_heal_rules AS PERMISSIVE FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS phr_service_all ON public.push_heal_rules;
CREATE POLICY phr_service_all ON public.push_heal_rules AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS pvt_auth_read ON public.push_verification_tasks;
CREATE POLICY pvt_auth_read ON public.push_verification_tasks AS PERMISSIVE FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS pvt_service_all ON public.push_verification_tasks;
CREATE POLICY pvt_service_all ON public.push_verification_tasks AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_api_usage_log ON public.api_usage_log;
CREATE POLICY service_role_api_usage_log ON public.api_usage_log AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_asin_traffic ON public.asin_traffic;
CREATE POLICY service_role_asin_traffic ON public.asin_traffic AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_keyword_analysis ON public.keyword_analysis;
CREATE POLICY service_role_keyword_analysis ON public.keyword_analysis AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_keyword_cache ON public.keyword_cache;
CREATE POLICY service_role_keyword_cache ON public.keyword_cache AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_keyword_rank_snapshots ON public.keyword_rank_snapshots;
CREATE POLICY service_role_keyword_rank_snapshots ON public.keyword_rank_snapshots AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_keyword_seed_pool ON public.keyword_seed_pool;
CREATE POLICY service_role_keyword_seed_pool ON public.keyword_seed_pool AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_keyword_share_snapshots ON public.keyword_share_snapshots;
CREATE POLICY service_role_keyword_share_snapshots ON public.keyword_share_snapshots AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_listing_rank_analysis ON public.listing_rank_analysis;
CREATE POLICY service_role_listing_rank_analysis ON public.listing_rank_analysis AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_parent_rollup ON public.parent_asin_rollup;
CREATE POLICY service_role_parent_rollup ON public.parent_asin_rollup AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_pt_schema_cache ON public.pt_schema_cache;
CREATE POLICY service_role_pt_schema_cache ON public.pt_schema_cache AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_push_jobs ON public.push_jobs;
CREATE POLICY service_role_push_jobs ON public.push_jobs AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---- 3. Views run as the caller, not the definer (069) ----------------------
ALTER VIEW public.api_usage_this_month SET (security_invoker=on);
ALTER VIEW public.v_missing_inventory SET (security_invoker=on);
ALTER VIEW public.v_missing_inventory_summary SET (security_invoker=on);
ALTER VIEW public.v_sku_parsed SET (security_invoker=on);

-- ---- 4. search_path pinned (069) -- blocks search-path hijack --------------
ALTER FUNCTION claim_listing(text,uuid,text,text,bigint) SET search_path=public;
ALTER FUNCTION cleanup_old_login_attempts() SET search_path=public, pg_catalog;
ALTER FUNCTION get_my_role() SET search_path=public;
ALTER FUNCTION handle_new_user() SET search_path=public, pg_catalog;
ALTER FUNCTION merge_theme_fit_by_design(text,text,text,jsonb) SET search_path=public, pg_catalog;
ALTER FUNCTION parse_sku_parts(text) SET search_path=public, pg_catalog;
ALTER FUNCTION protect_order_items_customization() SET search_path=public, pg_catalog;
ALTER FUNCTION rls_auto_enable() SET search_path=pg_catalog;
ALTER FUNCTION trigger_cleanup_old_orders() SET search_path=public, pg_catalog;
ALTER FUNCTION update_excess_inventory_updated_at() SET search_path=public, pg_catalog;
ALTER FUNCTION update_updated_at_column() SET search_path=public, pg_catalog;

-- ---- 5. NEW 2026-08-26: internal plumbing is not callable by anonymous users --
-- These five are trigger internals and server-side helpers. A trigger function is invoked
-- by the trigger mechanism, NOT via the caller's EXECUTE grant, so revoking cannot break
-- the triggers. merge_theme_fit_by_design WRITES and is only ever called from
-- /api/fba/keyword-pool/rerate on the service-role client (service_role is unaffected by
-- these grants). `authenticated` is deliberately left in place so no logged-in flow can
-- regress -- this removes anonymous-internet reach only.
REVOKE EXECUTE ON FUNCTION public.merge_theme_fit_by_design(text,text,text,jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.protect_order_items_customization() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.parse_sku_parts(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.update_excess_inventory_updated_at() FROM PUBLIC, anon;

-- STILL OPEN, deliberately -- needs a CODE change, not a grant change:
--   claim_listing / get_my_role are SECURITY DEFINER and executable by anon. Revoking
--   breaks the listing-claim feature; the correct fix is an internal auth.uid() check
--   inside each function body. Tracked, not addressed here.
--   Leaked-password protection requires a Supabase Pro plan; this project is on Free.
