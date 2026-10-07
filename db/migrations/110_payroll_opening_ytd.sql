-- Opening year-to-date figures: what an employee had earned and paid in tax before their first PEPL run.
--
-- A company that starts on PEPL part-way through a financial year has months of salary and tax deducted
-- behind it. TDS is projected from year-to-date figures, and with nowhere to record the earlier months the
-- first run computed tax as if the year had started that month. These rows carry the figures in.
--
-- Append-only, like every other record that a figure is later derived from: a correction is a NEW row and
-- the latest row for (employee, fiscal year) is the one in force, so the history of what was entered, by
-- whom and why is never rewritten. The runtime role may therefore only SELECT and INSERT.

CREATE TABLE IF NOT EXISTS payroll_opening_ytd (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL,
  fiscal_year   text NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}-[0-9]{2}$'),
  taxable_paise bigint NOT NULL CHECK (taxable_paise >= 0),
  tds_paise     bigint NOT NULL CHECK (tds_paise >= 0),
  reason        text NOT NULL CHECK (length(btrim(reason)) > 0),
  entered_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),   -- not now(): two entries in one transaction must still order
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

-- "The latest row for this employee and year" is the only read; this is its index.
CREATE INDEX IF NOT EXISTS payroll_opening_ytd_latest
  ON payroll_opening_ytd (tenant_id, employee_id, fiscal_year, created_at DESC);

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  ALTER TABLE payroll_opening_ytd ENABLE ROW LEVEL SECURITY;
  ALTER TABLE payroll_opening_ytd FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON payroll_opening_ytd;
  CREATE POLICY tenant_isolation ON payroll_opening_ytd
    USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
  EXECUTE format('GRANT SELECT, INSERT ON payroll_opening_ytd TO %I', app_role);
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON payroll_opening_ytd FROM %I', app_role);
END $$;
