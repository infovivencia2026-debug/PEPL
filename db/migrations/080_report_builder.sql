-- Report builder (blueprint C7): saved reports over declared read models,
-- and schedules that mail them.
--
-- A saved report is a SPEC (model, columns, filters, group-by, measures) —
-- never SQL. The builder in src/reports/builder.ts turns a spec into a
-- parameterised query over a whitelisted model; nothing from the spec is
-- interpolated. A schedule runs AS ITS OWNER: their permissions and scope
-- decide what the mailed file contains, and the file is a document owned by
-- the tenant, so it is retained and erased like any other.

CREATE TABLE IF NOT EXISTS saved_reports (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text,
  spec          jsonb NOT NULL,
  owner_user_id uuid NOT NULL,
  shared        boolean NOT NULL DEFAULT false,      -- visible to everyone holding the model's permission
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_user_id, name)
);

CREATE TABLE IF NOT EXISTS report_schedules (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  report_id     uuid NOT NULL,
  frequency     text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  day_of_week   smallint CHECK (day_of_week BETWEEN 0 AND 6),     -- weekly
  day_of_month  smallint CHECK (day_of_month BETWEEN 1 AND 28),   -- monthly
  hour          smallint NOT NULL DEFAULT 7 CHECK (hour BETWEEN 0 AND 23),
  recipients    text[] NOT NULL,
  format        text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  next_run_on   date NOT NULL,
  last_run_at   timestamptz,
  last_error    text,
  created_by_user_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, report_id) REFERENCES saved_reports (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS report_schedules_due_idx ON report_schedules (tenant_id, next_run_on) WHERE status = 'active';

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['saved_reports','report_schedules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
