-- Compliance calendar (blueprint C2): every statutory obligation as a row
-- with a due date, marked filed with evidence, scored over the year. The
-- obligations themselves are data (db/reference/compliance.ts); this table
-- is their instances for a company.

CREATE TABLE IF NOT EXISTS compliance_obligations (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  code          text NOT NULL,                       -- PF_ECR, ESI, TDS_192, PT, TDS_24Q, FORM16, LWF, POSH_ANNUAL, BONUS, …
  period        text NOT NULL,                       -- '2026-09', 'Q2 FY26-27', 'FY25-26', '2026'
  due_on        date NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','filed','not_applicable')),
  filed_on      date,
  filed_by_user_id uuid,
  evidence_document_id uuid,
  reference_no  text,                                -- TRRN, challan number, acknowledgement
  note          text,
  reminded_on   date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code, period)
);
CREATE INDEX IF NOT EXISTS compliance_due_idx ON compliance_obligations (tenant_id, due_on) WHERE status = 'pending';

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE compliance_obligations ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE compliance_obligations FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON compliance_obligations';
  EXECUTE 'CREATE POLICY tenant_isolation ON compliance_obligations USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON compliance_obligations TO %I', app_role);
END $$;
