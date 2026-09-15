-- Organisation masters: departments, locations, designations, grades.
--
-- Until now these were free text on the assignment row, so "Sales", "sales"
-- and "Sales " were three departments and no rule could be scoped to one.
-- Every rule a company wants to write — this shift for this location, this
-- incentive plan for this grade, this approval chain for this department —
-- needs a thing to point at. This is the thing.
--
-- One table, four kinds, because the lifecycle is identical: create, rename,
-- retire (never delete — a payslip from 2026 names the grade it was paid
-- under), reinstate. `attributes` carries the per-kind extras: a grade's CTC
-- band, a location's state for professional tax, a department's cost centre.
CREATE TABLE IF NOT EXISTS org_units (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('department','location','designation','grade')),
  -- Short, stable, upper-case; what rules and imports refer to.
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Departments nest (Sales > Sales North). Other kinds stay flat.
  parent_id   uuid,
  attributes  jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order  int  NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  retired_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES org_units (tenant_id, id),
  UNIQUE (tenant_id, kind, code)
);
CREATE INDEX IF NOT EXISTS org_units_kind_idx ON org_units (tenant_id, kind, status);

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE org_units ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE org_units FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON org_units';
  EXECUTE 'CREATE POLICY tenant_isolation ON org_units
             USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON org_units TO %I', app_role);
  EXECUTE format('REVOKE DELETE ON org_units FROM %I', app_role);
END $$;
