-- Row-level security. This is the second of three independent isolation checks
-- (composite FKs, application scope, RLS). See docs/architecture/tenancy-security.md.
--
-- current_tenant() returns NULL when app.tenant_id is unset, and `col = NULL`
-- evaluates to NULL, which fails the policy. A missing tenant context therefore
-- yields ZERO ROWS rather than all rows. That default must never be inverted.

CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- tenants is the tenant root: scoped on id, not tenant_id.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING      (id = current_tenant())
  WITH CHECK (id = current_tenant());

-- Tenant-owned tables. WITH CHECK matters as much as USING: without it a tenant
-- could WRITE a row belonging to another tenant even though it cannot read one back.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_users', 'employees', 'employee_assignments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;
