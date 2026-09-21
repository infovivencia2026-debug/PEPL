-- Work-from-home and field duty as attendance MODES.
--
-- A punch is inside or outside a fence; a person working from home or at a
-- client site is neither, and until now was refused or flagged. An approved
-- remote request for a date range turns the geofence off for those days and
-- marks them remote (WFH) or on duty (field). Field days can carry visit
-- logs — where, whom, what came of it, with the geo of the check-in — which
-- is the evidence a sales or service team runs on.

CREATE TABLE IF NOT EXISTS remote_requests (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id      uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('wfh','field')),
  starts_on        date NOT NULL,
  ends_on          date NOT NULL CHECK (ends_on >= starts_on),
  place            text,                         -- 'Home', 'Client: Acme, Pune', 'Site B'
  reason           text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approval_request_id uuid,
  requested_by_user_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS remote_requests_employee_idx ON remote_requests (tenant_id, employee_id, starts_on, ends_on) WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS field_visits (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id      uuid NOT NULL,
  work_date        date NOT NULL,
  place            text NOT NULL,                -- school / client / site
  contact          text,
  purpose          text NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  start_lat        double precision, start_lng double precision,
  end_lat          double precision,   end_lng   double precision,
  outcome          text,
  next_step        text,
  photo_document_ids uuid[] NOT NULL DEFAULT '{}',
  project_id       uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS field_visits_employee_idx ON field_visits (tenant_id, employee_id, work_date DESC);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['remote_requests','field_visits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
