-- Loans and salary advances.
--
-- A recovery that runs for months has to be a schedule, not a reminder: the
-- balance, the instalment, when it starts, and what has been taken so far —
-- with each deduction tied to the run that took it, so the balance is a sum
-- over facts and never a number somebody edited.
CREATE TABLE IF NOT EXISTS employee_loans (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id        uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('loan','advance')),
  principal_paise    bigint NOT NULL CHECK (principal_paise > 0),
  -- Interest-free by default; a rate spreads simple interest over the term.
  annual_interest_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (annual_interest_pct BETWEEN 0 AND 36),
  instalments        int NOT NULL CHECK (instalments BETWEEN 1 AND 120),
  instalment_paise   bigint NOT NULL CHECK (instalment_paise > 0),
  -- The first payroll period (by period_start) that deducts.
  starts_on          date NOT NULL,
  disbursed_on       date NOT NULL,
  reason             text,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','settled','written_off','cancelled')),
  closed_at          timestamptz,
  closed_reason      text,
  approved_by_user_id uuid,
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS employee_loans_open_idx ON employee_loans (tenant_id, employee_id) WHERE status = 'active';

-- One row per deduction taken, tied to the run. Released on unfreeze.
CREATE TABLE IF NOT EXISTS loan_repayments (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  loan_id       uuid NOT NULL,
  run_id        uuid,                   -- NULL for an out-of-payroll repayment (cash, exit settlement)
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  kind          text NOT NULL DEFAULT 'payroll' CHECK (kind IN ('payroll','manual','exit')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, loan_id) REFERENCES employee_loans (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS loan_repayments_run_idx ON loan_repayments (tenant_id, run_id);

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
        t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_loans','loan_repayments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON employee_loans TO %I', app_role);
  EXECUTE format('REVOKE DELETE ON employee_loans FROM %I', app_role);
  -- Unfreeze releases a run's repayments; that is the one delete.
  EXECUTE format('GRANT SELECT, INSERT, DELETE ON loan_repayments TO %I', app_role);
END $$;
