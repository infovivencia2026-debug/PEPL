-- Payroll. See docs/architecture/payroll.md.
--
-- THE rule: the engine never reads attendance_punches, daily_attendance or
-- leave_ledger. It reads payroll_inputs, written once per run revision by an
-- explicit, auditable freeze step. Everything else here follows from that.

-- ---------------------------------------------------------------------------
-- Statutory reference data. GLOBAL, not tenant-scoped: rates are the law, not a
-- customer preference. Effective-dated, and snapshotted onto every run so a
-- budget change never retroactively alters a locked payroll.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS statutory_configs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from            date NOT NULL,
  effective_to              date,
  pf_employee_rate          numeric(6,4) NOT NULL,
  pf_employer_rate          numeric(6,4) NOT NULL,
  pf_wage_ceiling_paise     bigint NOT NULL,
  esi_employee_rate         numeric(6,4) NOT NULL,
  esi_employer_rate         numeric(6,4) NOT NULL,
  esi_gross_threshold_paise bigint NOT NULL,
  notes                     text,
  UNIQUE (effective_from)
);

CREATE TABLE IF NOT EXISTS pt_slabs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code        text NOT NULL,
  effective_from    date NOT NULL,
  effective_to      date,
  gross_from_paise  bigint NOT NULL,
  gross_to_paise    bigint,
  amount_paise      bigint NOT NULL,
  month_override    smallint
);
CREATE INDEX IF NOT EXISTS pt_slab_lookup_idx ON pt_slabs (state_code, effective_from);

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE payroll_run_status AS ENUM
    ('draft','inputs_frozen','calculated','validated','approved','locked','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS payroll_periods (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  label        text NOT NULL,               -- '2026-09'
  period_start date NOT NULL,
  period_end   date NOT NULL,
  pay_date     date NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, label)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  period_id           uuid NOT NULL,
  revision            int NOT NULL DEFAULT 1,
  supersedes_run_id   uuid,
  status              payroll_run_status NOT NULL DEFAULT 'draft',
  employee_count      int,
  gross_paise         bigint,
  deductions_paise    bigint,
  net_paise           bigint,
  -- the resolved tenant configuration this run saw, so it reproduces exactly
  config_snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,
  statutory_config_id uuid,
  processed_by_user_id uuid,
  approved_by_user_id uuid,
  locked_by_user_id   uuid,
  frozen_at           timestamptz,
  calculated_at       timestamptz,
  approved_at         timestamptz,
  locked_at           timestamptz,
  correction_reason   text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES payroll_periods (tenant_id, id),
  UNIQUE (tenant_id, period_id, revision),
  -- a revision must say why it exists
  CHECK (revision = 1 OR correction_reason IS NOT NULL)
);

-- One row per employee per run. Written once at freeze; never updated.
CREATE TABLE IF NOT EXISTS payroll_inputs (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL,
  employee_id        uuid NOT NULL,
  calendar_days      numeric(5,2) NOT NULL,
  payable_days       numeric(5,2) NOT NULL,
  lop_days           numeric(5,2) NOT NULL DEFAULT 0,
  paid_leave_days    numeric(5,2) NOT NULL DEFAULT 0,
  ot_minutes         int NOT NULL DEFAULT 0,
  -- RESOLVED amounts, not a pointer to a structure that may later change.
  -- This is what makes a locked run reproducible five years later.
  monthly_components jsonb NOT NULL,
  annual_ctc_paise   bigint NOT NULL,
  state_code         text NOT NULL,
  pf_applicable      boolean NOT NULL DEFAULT true,
  esi_applicable     boolean NOT NULL DEFAULT false,
  tax_regime         text NOT NULL DEFAULT 'new',
  adhoc              jsonb NOT NULL DEFAULT '[]'::jsonb,
  joined_mid_period  boolean NOT NULL DEFAULT false,
  exited_mid_period  boolean NOT NULL DEFAULT false,
  fnf                boolean NOT NULL DEFAULT false,
  frozen_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  UNIQUE (tenant_id, run_id, employee_id)
);

CREATE TABLE IF NOT EXISTS payroll_lines (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  id             bigint GENERATED ALWAYS AS IDENTITY,
  run_id         uuid NOT NULL,
  employee_id    uuid NOT NULL,
  component_code text NOT NULL,
  component_type text NOT NULL CHECK (component_type IN
                   ('earning','deduction','employer_contribution','informational')),
  amount_paise   bigint NOT NULL,
  -- inputs + formula trace. Not decoration: the difference between a five-minute
  -- answer to a disputed number and a day of forensics.
  calc_note      jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs (tenant_id, id),
  UNIQUE (tenant_id, run_id, employee_id, component_code)
);

CREATE TABLE IF NOT EXISTS payslips (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL,
  employee_id      uuid NOT NULL,
  gross_paise      bigint NOT NULL,
  deductions_paise bigint NOT NULL,
  net_paise        bigint NOT NULL,
  published_at     timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs (tenant_id, id),
  UNIQUE (tenant_id, run_id, employee_id)
);

-- ---------------------------------------------------------------------------
-- Immutability, enforced in the DATABASE.
-- Service-layer checks are bypassed by background jobs, consoles and any future
-- caller. A locked run must be unwritable from every direction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_locked_payroll_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s payroll_run_status;
BEGIN
  SELECT status INTO s FROM payroll_runs
   WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
     AND id        = COALESCE(NEW.run_id,   OLD.run_id);
  IF s = 'locked' THEN
    RAISE EXCEPTION 'payroll run % is locked; create a revision instead',
      COALESCE(NEW.run_id, OLD.run_id)
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS payroll_inputs_immutable ON payroll_inputs;
CREATE TRIGGER payroll_inputs_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_inputs
  FOR EACH ROW EXECUTE FUNCTION reject_locked_payroll_write();

DROP TRIGGER IF EXISTS payroll_lines_immutable ON payroll_lines;
CREATE TRIGGER payroll_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_lines
  FOR EACH ROW EXECUTE FUNCTION reject_locked_payroll_write();

DROP TRIGGER IF EXISTS payslips_immutable ON payslips;
CREATE TRIGGER payslips_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON payslips
  FOR EACH ROW EXECUTE FUNCTION reject_locked_payroll_write();

-- From locked, the only permitted transition is none.
CREATE OR REPLACE FUNCTION reject_locked_run_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'locked' THEN
    RAISE EXCEPTION 'payroll run % is locked and cannot be modified; create a revision', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payroll_run_locked ON payroll_runs;
CREATE TRIGGER payroll_run_locked
  BEFORE UPDATE OR DELETE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION reject_locked_run_change();

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_periods','payroll_runs','payroll_inputs','payroll_lines','payslips'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  -- Statutory rates are read-only to the application: a tenant deviating from
  -- them does so through an explicit, acknowledged override, never by edit.
  EXECUTE format('GRANT SELECT ON statutory_configs, pt_slabs TO %I', app_role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON statutory_configs, pt_slabs FROM %I', app_role);
END $$;
