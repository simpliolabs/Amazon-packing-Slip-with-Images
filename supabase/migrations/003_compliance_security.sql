-- Migration 003: Amazon Credential Management 1.4 Compliance
-- Adds: password expiration tracking, login attempt lockout, invite TTL, API key rotation

-- 1. Add password_changed_at and invite_expires_at to user_profiles
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invite_expires_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS mfa_enrolled boolean DEFAULT false;

-- 2. Create login_attempts table for account lockout
CREATE TABLE IF NOT EXISTS public.login_attempts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email text NOT NULL,
  ip_address text,
  success boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Index for fast lookups by email and time
CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time
  ON public.login_attempts (email, created_at DESC);

-- Auto-cleanup: delete login attempts older than 24 hours
CREATE OR REPLACE FUNCTION public.cleanup_old_login_attempts()
RETURNS void AS $$
BEGIN
  DELETE FROM public.login_attempts WHERE created_at < now() - interval '24 hours';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Add credentials_rotated_at to app_settings
-- We'll store this as a key-value pair: 'amazon_credentials_rotated_at'
-- No schema change needed — uses existing app_settings table

-- 4. RLS policies for login_attempts (service role only)
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage login_attempts"
  ON public.login_attempts
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Only allow service role to access login_attempts
-- Regular users should not be able to read or modify this table
REVOKE ALL ON public.login_attempts FROM anon, authenticated;
GRANT ALL ON public.login_attempts TO service_role;

-- 5. Update audit_logs to include new action types
-- (audit_logs table already exists, just documenting new actions:
--  'user.login_failed', 'user.account_locked', 'user.mfa_enrolled',
--  'user.password_expired', 'credentials.rotation_warning')
