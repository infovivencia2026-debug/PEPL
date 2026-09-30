-- A session or an API key is only as good as the user it belongs to.
--
-- auth_session_by_hash and auth_api_key_by_hash looked at the credential row alone
-- (not revoked, not expired). Disabling a user -- or an employee leaving -- therefore
-- changed nothing for a session or key already issued: it kept resolving, with all the
-- roles the user held, until it expired on its own.
--
-- Both now join the user and require status = 'active'. Any way of deactivating someone
-- cuts them off at the next request, and the credential itself is untouched, so
-- reinstating the user restores what they had.
--
-- SECURITY DEFINER runs as the owner, and app_users' `identity_lookup_owner` policy is
-- what lets the owner read it (FORCE ROW LEVEL SECURITY applies to the owner too).

CREATE OR REPLACE FUNCTION auth_session_by_hash(p_hash text)
RETURNS TABLE(tenant_id uuid, user_id uuid, id uuid, mfa_pending boolean, mfa_verified_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.tenant_id, s.user_id, s.id, s.mfa_pending, s.mfa_verified_at
    FROM public.sessions s
    JOIN public.app_users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
   WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > now()
     AND u.status = 'active'
$$;

CREATE OR REPLACE FUNCTION auth_api_key_by_hash(p_hash text)
RETURNS TABLE(tenant_id uuid, id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT k.tenant_id, k.id, k.user_id
    FROM public.api_keys k
    JOIN public.app_users u ON u.tenant_id = k.tenant_id AND u.id = k.user_id
   WHERE k.key_hash = p_hash AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
     AND u.status = 'active'
$$;
