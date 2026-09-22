-- Pay operations (blueprint B5).
--
-- Ledger mapping: which accounting head each payroll component posts to, so
-- a locked run exports as a balanced journal (Tally XML / CSV) instead of a
-- spreadsheet someone retypes. Payment reconciliation: the bank's return file
-- marks instructions settled or failed by UTR. Per-diem: daily allowance by
-- city class and grade, claimed as an expense with no receipt.

CREATE TABLE IF NOT EXISTS ledger_mappings (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  component_code  text NOT NULL,                     -- BASIC, HRA, PF_EE, PF_ER, TDS, NET_PAY, … or '*' default by type
  component_type  text,                              -- when component_code = '*'
  debit_account   text,                              -- 'Salaries & Wages', '4001'
  credit_account  text,                              -- 'Salary Payable', 'PF Payable'
  cost_centre_by  text NOT NULL DEFAULT 'department' CHECK (cost_centre_by IN ('none','department','location','cost_centre')),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, component_code)
);

CREATE TABLE IF NOT EXISTS per_diem_rates (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  city_class    text NOT NULL CHECK (city_class IN ('metro','tier1','tier2','other','international')),
  grade_code    text,                                -- NULL = every grade
  rate_paise    bigint NOT NULL CHECK (rate_paise >= 0),
  half_day_pct  int  NOT NULL DEFAULT 50 CHECK (half_day_pct BETWEEN 0 AND 100),
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, city_class, grade_code, effective_from)
);

ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS per_diem jsonb;   -- { cityClass, days, halfDays, ratePaise }

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_mappings','per_diem_rates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
