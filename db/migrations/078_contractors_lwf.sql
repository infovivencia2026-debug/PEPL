-- Contractor workforce and Labour Welfare Fund reference rates (blueprint C5).
--
-- A contractor is an employee row (so attendance, assets, documents, chat and
-- exit all work) with contractor_terms attached: PAN/GSTIN, the TDS section
-- their fees fall under, a rate. They are paid on INVOICE, never through the
-- payroll run — no PF, no ESI, no PT, no Form 16; TDS under 194C/194J/194H is
-- deducted per invoice and reported on 26Q. freezeInputs refuses them.
--
-- lwf_rates is global reference data like pt_slabs: the state's employee and
-- employer contribution and the months it is deducted in.

CREATE TABLE IF NOT EXISTS contractor_terms (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  employee_id   uuid NOT NULL,
  pan           text,
  gstin         text,
  entity_type   text NOT NULL DEFAULT 'individual' CHECK (entity_type IN ('individual','huf','firm','company')),
  tds_section   text NOT NULL DEFAULT '194J' CHECK (tds_section IN ('194C','194J','194H','none')),
  tds_rate_pct  numeric(5,2),                         -- NULL = statutory rate for the section and entity
  rate_type     text NOT NULL DEFAULT 'monthly' CHECK (rate_type IN ('monthly','daily','hourly','per_unit','fixed')),
  rate_paise    bigint NOT NULL DEFAULT 0 CHECK (rate_paise >= 0),
  invoice_required boolean NOT NULL DEFAULT true,
  contract_start date,
  contract_end   date,
  notes         text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS contractor_invoices (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL,
  invoice_no    text NOT NULL,
  invoice_date  date NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL CHECK (period_end >= period_start),
  description   text,
  units         numeric(10,2),
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),           -- fees before GST
  gst_paise     bigint NOT NULL DEFAULT 0 CHECK (gst_paise >= 0),
  tds_section   text NOT NULL,
  tds_rate_pct  numeric(5,2) NOT NULL,
  tds_paise     bigint NOT NULL CHECK (tds_paise >= 0),             -- on fees, never on GST
  net_paise     bigint NOT NULL,                                     -- amount + gst − tds
  status        text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','paid')),
  document_id   uuid,
  submitted_by_user_id uuid,
  approved_by_user_id uuid,
  approved_at   timestamptz,
  paid_at       timestamptz,
  payment_ref   text,
  rejection_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_id, invoice_no),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS contractor_invoices_period_idx ON contractor_invoices (tenant_id, invoice_date);

CREATE TABLE IF NOT EXISTS lwf_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code      text NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  employee_paise  bigint NOT NULL CHECK (employee_paise >= 0),
  employer_paise  bigint NOT NULL CHECK (employer_paise >= 0),
  deduction_months smallint[] NOT NULL,                 -- e.g. {6,12} half-yearly, {12} annual, {1..12} monthly
  wage_ceiling_paise bigint                             -- NULL = everyone
);
CREATE INDEX IF NOT EXISTS lwf_rates_lookup_idx ON lwf_rates (state_code, effective_from);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['contractor_terms','contractor_invoices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  -- an invoice is a financial record: it changes status, it is never deleted
  EXECUTE format('REVOKE DELETE ON contractor_invoices FROM %I', app_role);
  EXECUTE format('GRANT SELECT ON lwf_rates TO %I', app_role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON lwf_rates FROM %I', app_role);
END $$;
