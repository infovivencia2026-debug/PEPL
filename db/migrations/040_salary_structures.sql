-- Salary components and structures.
--
-- compensation_records.components was a free-form JSON of whatever HR typed:
-- "basic", "Basic" and "BASIC" were three components, and the engine decided
-- PF wages by a hard-coded list. A COMPONENT is now a defined thing with the
-- flags payroll needs — is it taxable, does PF count it, does ESI — and a
-- STRUCTURE is a template that turns an annual figure into the monthly
-- breakdown by formula, so a CTC becomes a payslip without arithmetic by hand.
--
-- Structures are retire-and-succeed, like shifts: a line that changes would
-- silently change what "Grade B structure" meant on last year's payslips.
CREATE TABLE IF NOT EXISTS salary_components (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,23}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind        text NOT NULL CHECK (kind IN ('earning','deduction')),
  taxable     boolean NOT NULL DEFAULT true,
  pf_wage     boolean NOT NULL DEFAULT false,   -- counts toward PF wages (basic, DA)
  esi_wage    boolean NOT NULL DEFAULT true,    -- counts toward ESI gross
  -- A reimbursement needs a bill; the engine does not care, the UI does.
  bill_required boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  retired_at  timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS salary_structures (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Ordered lines. Each: { component: 'HRA', formula: { type: 'percent_of', of: 'BASIC' | 'CTC', pct: 40 }
  --                                    | { type: 'fixed', paise: 160000 } | { type: 'balance' } }
  -- Exactly one 'balance' line absorbs what is left of the monthly figure.
  lines       jsonb NOT NULL,
  -- Which grades it is offered to; empty = any. Codes from org_units.
  grade_codes text[] NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  retired_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- Which structure a compensation record was derived from, if any.
ALTER TABLE compensation_records ADD COLUMN IF NOT EXISTS structure_code text;

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
        t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['salary_components','salary_structures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO %I', t, app_role);
    EXECUTE format('REVOKE DELETE ON %I FROM %I', t, app_role);
  END LOOP;
END $$;
