-- auth_mfa_enabled() runs BEFORE a tenant is known (at login), as the owner via
-- SECURITY DEFINER. FORCE ROW LEVEL SECURITY applies to the owner too, so with no
-- tenant context it saw nothing and every account read as "no MFA". Same fix as
-- 018 gave app_users and sessions: the owner may read across tenants, the app
-- role never can.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY identity_lookup_owner ON user_mfa TO %I USING (tenant_id = current_tenant() OR current_user = %L) WITH CHECK (tenant_id = current_tenant())', current_user, current_user);
END $$;
