-- Statutory identifiers, because a filing is not a filing without them.
--
-- PF, ESI and TDS returns are keyed on numbers that belong to the PERSON, not
-- to us: UAN, the PF member id, the ESI insurance number, the PAN. Payroll has
-- been computing correct contributions and had nowhere to file them.
--
-- Separate from `employees` for the same reason bank details are: this is the
-- sensitive tier. A PAN is a national identifier and an ESI number is a health
-- entitlement — both belong behind compensation.read, not on the profile every
-- colleague can open.
CREATE TABLE IF NOT EXISTS employee_statutory_ids (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL,
  -- 12 digits, issued once and portable across employers for life.
  uan           text CHECK (uan IS NULL OR uan ~ '^[0-9]{12}$'),
  -- The establishment-scoped member id, e.g. TNMAS00123450000000123.
  pf_member_id  text,
  -- 10 or 17 digits depending on the state's issuing system.
  esi_number    text CHECK (esi_number IS NULL OR esi_number ~ '^[0-9]{10}([0-9]{7})?$'),
  -- AAAAA9999A. Wrong-format PANs are the most common reason a 24Q is rejected,
  -- so the shape is enforced here rather than discovered by the department.
  pan           text CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  UNIQUE (tenant_id, employee_id)
);

-- A UAN belongs to one person. Two employees sharing one is either a typo or
-- a duplicate record, and either way the ECR would be rejected.
CREATE UNIQUE INDEX IF NOT EXISTS employee_uan_idx
  ON employee_statutory_ids (tenant_id, uan) WHERE uan IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS employee_pan_idx
  ON employee_statutory_ids (tenant_id, pan) WHERE pan IS NOT NULL;

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE employee_statutory_ids ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE employee_statutory_ids FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON employee_statutory_ids';
  EXECUTE 'CREATE POLICY tenant_isolation ON employee_statutory_ids
             USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON employee_statutory_ids TO %I', app_role);
  -- Corrected, never deleted: a filed return refers to what was true then.
  EXECUTE format('REVOKE DELETE ON employee_statutory_ids FROM %I', app_role);
END $$;
