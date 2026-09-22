-- Anomaly findings (blueprint D). One table for what the guards notice —
-- payroll guards run on a calculated run before approval; attendance guards
-- run nightly. A finding is open until someone dismisses it WITH A REASON;
-- a payroll run cannot be approved while a blocking finding on it is open.
-- Findings are evidence: never deleted by the app role.

CREATE TABLE IF NOT EXISTS anomaly_findings (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  area          text NOT NULL CHECK (area IN ('payroll','attendance')),
  code          text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('blocking','warning','info')),
  run_id        uuid,                                   -- payroll: the run it was found on
  employee_id   uuid,
  fingerprint   text NOT NULL,                          -- same anomaly re-found is the same row
  message       text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','resolved')),
  found_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  dismissed_by_user_id uuid,
  dismissed_at  timestamptz,
  dismiss_reason text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS anomaly_findings_open_idx ON anomaly_findings (tenant_id, area, status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS anomaly_findings_run_idx ON anomaly_findings (tenant_id, run_id) WHERE run_id IS NOT NULL;

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE anomaly_findings ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE anomaly_findings FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON anomaly_findings';
  EXECUTE 'CREATE POLICY tenant_isolation ON anomaly_findings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON anomaly_findings TO %I', app_role);
  EXECUTE format('REVOKE DELETE ON anomaly_findings FROM %I', app_role);
END $$;
