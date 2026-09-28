-- Let the company picker read a company name.
--
-- 089 added `auth_company_names`, a SECURITY DEFINER function, and it still
-- returned nothing: `tenants` has FORCE ROW LEVEL SECURITY, which applies to
-- the table owner too, so running as `pepl_owner` is not a way past the policy.
-- The picker offered two companies both called "Company".
--
-- `app_users` already solved exactly this for the credential lookup, with a
-- second permissive policy naming the owner (`identity_lookup_owner`). This is
-- the same trade, made the same way, for the same reason: a login has to read
-- across tenants BEFORE a tenant is known, and the alternative is a login that
-- cannot tell you whose payroll you are about to open.
--
-- What keeps it narrow:
--   - `pepl_owner` is a migrations/DDL role and never a runtime connection, so
--     the only thing that runs as it is a SECURITY DEFINER function we wrote.
--   - `auth_company_names` returns a display name for ids the caller passes in,
--     and callers only ever pass ids a password was just verified against.
--   - The application role `pepl_app` is untouched: it still sees exactly one
--     tenant, the one in its transaction context.

CREATE POLICY company_name_lookup_owner ON tenants
  FOR SELECT
  USING (CURRENT_USER = 'pepl_owner');

COMMENT ON POLICY company_name_lookup_owner ON tenants IS
  'For auth_company_names during login, before a tenant context exists. Mirrors identity_lookup_owner on app_users.';
