-- Multi-factor authentication (blueprint A6).
--
-- A user enrols a TOTP authenticator; from then on a login yields a session
-- that is PENDING until the code is verified, and authed() refuses a pending
-- session everywhere except the verify route. Recovery codes are stored
-- hashed and consumed on use. The session remembers when MFA was last
-- verified so payroll lock and bank-file download can insist on a recent one.

CREATE TABLE IF NOT EXISTS user_mfa (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL,
  secret          bytea NOT NULL,                    -- raw TOTP secret, 20 bytes
  enabled_at      timestamptz,                       -- NULL while setup is pending
  recovery_hashes text[] NOT NULL DEFAULT '{}',      -- sha256 of each unused recovery code
  last_used_step  bigint,                            -- replay guard: a code is good once
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_users (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_pending     boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE user_mfa FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON user_mfa';
  EXECUTE 'CREATE POLICY tenant_isolation ON user_mfa USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa TO %I', app_role);
END $$;

-- The session lookup now says whether the second factor is still owed.
DROP FUNCTION IF EXISTS auth_session_by_hash(text);
CREATE FUNCTION auth_session_by_hash(p_hash text)
RETURNS TABLE(tenant_id uuid, user_id uuid, id uuid, mfa_pending boolean, mfa_verified_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.tenant_id, s.user_id, s.id, s.mfa_pending, s.mfa_verified_at FROM public.sessions s
  WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > now()
$$;
REVOKE ALL ON FUNCTION auth_session_by_hash(text) FROM PUBLIC;

-- Login needs to know, pre-tenant, whether the account has MFA enabled.
CREATE OR REPLACE FUNCTION auth_mfa_enabled(p_tenant uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_mfa m WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.enabled_at IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION auth_mfa_enabled(uuid, uuid) FROM PUBLIC;
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION auth_session_by_hash(text), auth_mfa_enabled(uuid, uuid) TO %I', app_role);
END $$;
