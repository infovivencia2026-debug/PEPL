-- Narrow pre-tenant identity lookups. Runtime queries retain forced RLS.
-- Only these SECURITY DEFINER functions run as the migration owner; the
-- owner-only policy never grants the application role cross-tenant SELECT.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY identity_lookup_owner ON app_users TO %I USING (tenant_id = current_tenant() OR current_user = %L) WITH CHECK (tenant_id = current_tenant())', current_user, current_user);
  EXECUTE format('CREATE POLICY identity_lookup_owner ON sessions TO %I USING (tenant_id = current_tenant() OR current_user = %L) WITH CHECK (tenant_id = current_tenant())', current_user, current_user);
END $$;

CREATE FUNCTION auth_user_by_email(p_email text)
RETURNS TABLE(tenant_id uuid, id uuid, password_hash text, status text, employee_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.tenant_id, u.id, u.password_hash, u.status, u.employee_id
  FROM public.app_users u WHERE lower(u.email) = lower(p_email)
  -- Ambiguous emails fail closed rather than choosing an arbitrary company.
  AND (SELECT count(*) FROM public.app_users x WHERE lower(x.email) = lower(p_email)) = 1
$$;
CREATE FUNCTION auth_session_by_hash(p_hash text)
RETURNS TABLE(tenant_id uuid, user_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.tenant_id, s.user_id, s.id FROM public.sessions s
  WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > now()
$$;
REVOKE ALL ON FUNCTION auth_user_by_email(text), auth_session_by_hash(text) FROM PUBLIC;
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION auth_user_by_email(text), auth_session_by_hash(text) TO %I', app_role);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE login_attempts_id_seq TO %I', app_role);
END $$;
