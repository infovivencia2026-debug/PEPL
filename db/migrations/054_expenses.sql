-- Expenses and travel.
--
-- A claim is money the company owes a person for something they paid for.
-- It is raised against a category (which carries the policy: per-claim
-- limit, receipt required), goes through the approval engine like leave and
-- salary revisions, and is reimbursed through payroll as a non-taxable
-- REIMBURSEMENT line on the next run — the same freeze/unfreeze/lock hooks
-- exit settlements and loan instalments use, so a claim is paid exactly once.
--
-- Travel is a request (itinerary, estimate) with an optional advance, paid
-- the same way; the claims filed against it settle the advance.

CREATE TABLE IF NOT EXISTS expense_categories (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  code                 text NOT NULL,
  name                 text NOT NULL,
  -- policy
  per_claim_limit_paise bigint CHECK (per_claim_limit_paise IS NULL OR per_claim_limit_paise > 0),
  monthly_limit_paise  bigint CHECK (monthly_limit_paise IS NULL OR monthly_limit_paise > 0),
  receipt_required_above_paise bigint NOT NULL DEFAULT 0,   -- 0 = never required; N = required above N paise
  mileage_rate_paise_per_km bigint,           -- set for a mileage category: amount = km × rate
  taxable              boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS travel_requests (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id          uuid NOT NULL,
  purpose              text NOT NULL,
  destination          text NOT NULL,
  starts_on            date NOT NULL,
  ends_on              date NOT NULL CHECK (ends_on >= starts_on),
  estimated_paise      bigint NOT NULL DEFAULT 0 CHECK (estimated_paise >= 0),
  advance_paise        bigint NOT NULL DEFAULT 0 CHECK (advance_paise >= 0),
  status               text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','cancelled','advance_paid','settled')),
  approval_request_id  uuid,
  advance_run_id       uuid,                  -- the payroll run that paid the advance
  recovery_paise       bigint NOT NULL DEFAULT 0 CHECK (recovery_paise >= 0),   -- unspent advance, recovered on settlement
  recovery_run_id      uuid,
  requested_by_user_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  decided_at           timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS travel_requests_employee_idx ON travel_requests (tenant_id, employee_id, starts_on DESC);

CREATE TABLE IF NOT EXISTS expense_claims (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id          uuid NOT NULL,
  category_id          uuid NOT NULL,
  travel_request_id    uuid,
  incurred_on          date NOT NULL,
  amount_paise         bigint NOT NULL CHECK (amount_paise > 0),
  distance_km          numeric(8,1),
  description          text NOT NULL,
  merchant             text,
  receipt_document_id  uuid,
  cost_centre          text,
  status               text NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted','approved','rejected','cancelled','in_payroll','reimbursed')),
  approval_request_id  uuid,
  reimbursement_run_id uuid,
  reimbursed_at        timestamptz,
  requested_by_user_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  decided_at           timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES expense_categories (tenant_id, id),
  FOREIGN KEY (tenant_id, travel_request_id) REFERENCES travel_requests (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS expense_claims_employee_idx ON expense_claims (tenant_id, employee_id, incurred_on DESC);
CREATE INDEX IF NOT EXISTS expense_claims_payable_idx ON expense_claims (tenant_id, employee_id) WHERE status = 'approved';
-- Duplicate detection: same person, same amount, same day, same category is a resubmission until proven otherwise.
CREATE INDEX IF NOT EXISTS expense_claims_dup_idx ON expense_claims (tenant_id, employee_id, category_id, incurred_on, amount_paise)
  WHERE status NOT IN ('rejected','cancelled');

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['expense_categories','travel_requests','expense_claims'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
