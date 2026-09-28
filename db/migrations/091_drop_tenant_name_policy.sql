-- Reverses 090, which was the wrong answer.
--
-- 090 added a policy on `tenants` permitting `pepl_owner` to read every row, so
-- that a SECURITY DEFINER function could put real company names in the login
-- picker. `npm run gate:rls` refused it, and the gate was right: it fails any
-- policy on a tenant-scoped table that does not reference current_tenant(),
-- because that is the single invariant the whole isolation model rests on. A
-- policy is not less dangerous for being added by someone with a good reason.
--
-- The name lookup belongs on the CONTROL connection instead, which is the
-- sanctioned path for a cross-tenant read and is already how provisioning and
-- billing reach tenant rows. It never touches the application role, so nothing
-- a customer's session can do is widened by it.
--
-- `auth_company_names` from 089 is left in place but unused; it is harmless,
-- and dropping a function other deployments may already have is a bigger
-- change than leaving one behind.

DROP POLICY IF EXISTS company_name_lookup_owner ON tenants;
