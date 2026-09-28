-- Names for the company picker.
--
-- 088 let one address open several companies and asks which. The picker showed
-- "Company" twice, because `tenants` is RLS-protected and at that moment there
-- is no tenant context — the app role correctly sees nothing. That is the
-- documented default doing its job (no context yields zero rows, never all
-- rows), so the fix is not to relax the policy but to ask a narrow question
-- through the same door `auth_user_by_email` uses.
--
-- Deliberately minimal: it returns a display name for ids the caller already
-- holds, and nothing else about a tenant. Callers only ever hold ids the
-- password has just been verified against.

CREATE OR REPLACE FUNCTION auth_company_names(p_ids uuid[])
RETURNS TABLE(id uuid, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.id, t.display_name FROM public.tenants t WHERE t.id = ANY(p_ids)
$$;

REVOKE ALL ON FUNCTION auth_company_names(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_company_names(uuid[]) TO pepl_app;

COMMENT ON FUNCTION auth_company_names(uuid[]) IS
  'Display names for companies whose ids the caller already proved a password against. Nothing else.';
