-- Fix mutable search_path security warnings on all PL/pgSQL functions
ALTER FUNCTION public.trigger_cleanup_old_orders() SET search_path = public, pg_catalog;
ALTER FUNCTION public.handle_new_user() SET search_path = public, pg_catalog;
ALTER FUNCTION public.update_updated_at_column() SET search_path = public, pg_catalog;
