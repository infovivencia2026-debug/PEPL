-- Password reset tokens.
--
-- An employee who forgets their password was locked out until HR intervened.
-- The token is single-use, short-lived, and stored HASHED — a database read
-- must not yield a working reset link any more than it yields a session.
CREATE TABLE IF NOT EXISTS password_resets (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  token_hash    text NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  requested_ip  inet,
  -- Who asked: the person via forgot-password, or an admin issuing a link.
  issued_by_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_users (tenant_id, id) ON DELETE CASCADE
);

-- Like sessions: the token arrives BEFORE a tenant is known.
CREATE UNIQUE INDEX IF NOT EXISTS password_resets_token_idx ON password_resets (token_hash);

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE password_resets FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON password_resets';
  EXECUTE 'CREATE POLICY tenant_isolation ON password_resets
             USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON password_resets TO %I', app_role);
END $$;

-- The one pre-tenant lookup, same shape as auth_session_by_hash: the hash in,
-- the tenant and user out, nothing else. Expired and used tokens do not resolve.
CREATE FUNCTION auth_reset_by_hash(p_hash text)
RETURNS TABLE(tenant_id uuid, user_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.tenant_id, r.user_id, r.id FROM public.password_resets r
  WHERE r.token_hash = p_hash AND r.used_at IS NULL AND r.expires_at > now()
$$;
REVOKE ALL ON FUNCTION auth_reset_by_hash(text) FROM PUBLIC;
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION auth_reset_by_hash(text) TO %I', app_role);
  -- The owner needs to see the row through RLS for the definer function to work.
  EXECUTE format('CREATE POLICY identity_lookup_owner ON password_resets TO %I USING (tenant_id = current_tenant() OR current_user = %L) WITH CHECK (tenant_id = current_tenant())', current_user, current_user);
END $$;
