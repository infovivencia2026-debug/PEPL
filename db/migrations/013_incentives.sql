-- Incentives. See docs/architecture/field-sales-ops.md §6.
--
-- Deliberately the SAME shape as payroll: aggregate -> close -> calculate ->
-- approve -> push. Variable pay is the second most common payroll dispute after
-- LOP, and it is unanswerable without a stored calculation trace.

CREATE TABLE IF NOT EXISTS incentive_plans (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  version         int NOT NULL DEFAULT 1,
  metric          text NOT NULL DEFAULT 'sales_value',
  -- a fixed vocabulary, not a formula language: a tenant composes slabs and
  -- rates, it does not write expressions
  calc_type       text NOT NULL CHECK (calc_type IN ('slab','percent_of_metric','flat_on_target','per_unit')),
  config          jsonb NOT NULL,
  proration_rule  text NOT NULL DEFAULT 'by_payable_days',
  clawback_enabled boolean NOT NULL DEFAULT false,
  effective_from  date NOT NULL,
  effective_to    date,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name, version)
);

CREATE TABLE IF NOT EXISTS incentive_periods (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  label        text NOT NULL,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','closed','calculated','approved','paid')),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, label)
);

CREATE TABLE IF NOT EXISTS incentive_targets (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL,
  plan_id      uuid NOT NULL,
  period_id    uuid NOT NULL,
  target_value numeric(16,3) NOT NULL,
  weight       numeric(5,2) NOT NULL DEFAULT 100,
  set_by_user_id uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES incentive_plans (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES incentive_periods (tenant_id, id),
  UNIQUE (tenant_id, employee_id, plan_id, period_id)
);

-- Raw achievement, append-only and idempotent by external reference so an import
-- can be re-run. Aggregation over this is derived and re-runnable, exactly like
-- attendance -> daily_attendance.
CREATE TABLE IF NOT EXISTS sales_records (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL,
  period_id    uuid NOT NULL,
  occurred_on  date NOT NULL,
  value_paise  bigint NOT NULL,
  quantity     numeric(14,3),
  source       text NOT NULL DEFAULT 'manual',
  external_ref text,
  is_reversed  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES incentive_periods (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_external_ref_idx
  ON sales_records (tenant_id, source, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS incentive_calculations (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  period_id            uuid NOT NULL,
  employee_id          uuid NOT NULL,
  plan_id              uuid NOT NULL,
  target_value         numeric(16,3) NOT NULL,
  achieved_value       numeric(16,3) NOT NULL,
  achievement_pct      numeric(9,3) NOT NULL,
  proration_factor     numeric(6,4) NOT NULL DEFAULT 1,
  gross_incentive_paise bigint NOT NULL,
  adjustment_paise     bigint NOT NULL DEFAULT 0,
  final_incentive_paise bigint NOT NULL,
  -- which slab applied and why. Not decoration.
  calc_trace           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'calculated'
                       CHECK (status IN ('calculated','approved','pushed','cancelled')),
  approved_by_user_id  uuid,
  payroll_run_id       uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES incentive_periods (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  UNIQUE (tenant_id, period_id, employee_id, plan_id)
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['incentive_plans','incentive_periods','incentive_targets',
                           'sales_records','incentive_calculations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
