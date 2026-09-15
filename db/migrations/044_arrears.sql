-- Arrears.
--
-- A salary revision effective-dated into a month that has already been paid
-- changed nothing that was paid: the locked run is immutable, and the next run
-- only knew the new salary from its own period. The difference for the
-- months in between — arrears — is owed and was silently not paid.
--
-- One row per (employee, revision record, prior run) the moment the arrears
-- are frozen into a run, so the same month is never paid twice however many
-- times payroll is unfrozen and refrozen. Released on unfreeze, like the
-- settlement, because the run that would have paid them no longer will.
CREATE TABLE IF NOT EXISTS arrears_paid (
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  id                       uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id              uuid NOT NULL,
  compensation_record_id   uuid NOT NULL,
  source_run_id            uuid NOT NULL,    -- the locked run that under-paid
  paid_in_run_id           uuid NOT NULL,    -- the run carrying the ARREARS line
  old_gross_paise          bigint NOT NULL,
  new_gross_paise          bigint NOT NULL,
  amount_paise             bigint NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  UNIQUE (tenant_id, employee_id, compensation_record_id, source_run_id)
);

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE arrears_paid ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE arrears_paid FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON arrears_paid';
  EXECUTE 'CREATE POLICY tenant_isolation ON arrears_paid
             USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
  -- Unfreeze releases rows; that is the one legitimate delete.
  EXECUTE format('GRANT SELECT, INSERT, DELETE ON arrears_paid TO %I', app_role);
END $$;
