-- Separations and full-and-final settlement.
--
-- `exitedMidPeriod` was a flag with nothing behind it: there was no record of
-- WHEN someone left, WHY, what notice they owed, or what the company owed them
-- — gratuity after five years, encashment of the leave they never took,
-- recovery of the notice they did not serve. This is that record.
--
-- The settlement figures are resolved ONCE, when the final payroll run is
-- frozen, and written here as values — the same invariant as payroll_inputs.
-- A settlement that recomputed itself from live leave balances would change
-- after the payslip was issued.
CREATE TABLE IF NOT EXISTS employee_separations (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id          uuid NOT NULL,
  reason               text NOT NULL CHECK (reason IN
                         ('resignation','termination','retirement','end_of_contract','death','absconding')),
  initiated_on         date NOT NULL DEFAULT CURRENT_DATE,
  last_working_day     date NOT NULL,
  -- What the contract requires and what was actually served. The shortfall is
  -- recovered from the final pay unless waived.
  notice_days_required int  NOT NULL DEFAULT 0 CHECK (notice_days_required >= 0),
  notice_waived        boolean NOT NULL DEFAULT false,
  -- Deductions the company adds by hand: asset not returned, loan balance.
  recoveries_paise     bigint NOT NULL DEFAULT 0 CHECK (recoveries_paise >= 0),
  recoveries_note      text,
  status               text NOT NULL DEFAULT 'initiated'
                         CHECK (status IN ('initiated','in_payroll','settled','cancelled')),
  -- Resolved at freeze of the final run. NULL until then.
  settlement           jsonb,
  settlement_run_id    uuid,
  settled_at           timestamptz,
  initiated_by_user_id uuid,
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CHECK (last_working_day >= initiated_on - 365)
);

-- One open separation per employee. A cancelled one may be followed by another.
CREATE UNIQUE INDEX IF NOT EXISTS employee_open_separation_idx
  ON employee_separations (tenant_id, employee_id)
  WHERE status IN ('initiated','in_payroll');

-- When did they leave? Denormalised onto the employee so every "active
-- headcount" query stays a status check, not a join.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS date_of_exit date;

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE employee_separations ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE employee_separations FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON employee_separations';
  EXECUTE 'CREATE POLICY tenant_isolation ON employee_separations
             USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON employee_separations TO %I', app_role);
  -- Cancelled, never deleted: an exit that was started and reversed is history.
  EXECUTE format('REVOKE DELETE ON employee_separations FROM %I', app_role);
END $$;
