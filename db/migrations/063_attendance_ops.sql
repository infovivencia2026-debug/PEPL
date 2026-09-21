-- Attendance operations (blueprint A4): recorded breaks, a reason for a late
-- punch, days the system closed because nobody punched out, and the per-tenant
-- secret behind rotating QR punch codes.

CREATE TABLE IF NOT EXISTS attendance_breaks (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL,
  work_date    date NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  kind         text NOT NULL DEFAULT 'break',      -- break | lunch | personal
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_breaks_one_open_idx ON attendance_breaks (tenant_id, employee_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS attendance_breaks_day_idx ON attendance_breaks (tenant_id, employee_id, work_date);

ALTER TABLE daily_attendance ADD COLUMN IF NOT EXISTS late_reason text;
ALTER TABLE daily_attendance ADD COLUMN IF NOT EXISTS auto_closed boolean NOT NULL DEFAULT false;
ALTER TABLE attendance_punches ADD COLUMN IF NOT EXISTS via text;      -- 'qr' when a kiosk code was scanned

-- One secret per tenant. Rotating it invalidates every code at once.
CREATE TABLE IF NOT EXISTS attendance_qr_secrets (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  secret     bytea NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id)
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_breaks','attendance_qr_secrets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
