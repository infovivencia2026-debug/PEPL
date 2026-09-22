-- Org structure (blueprint B4): positions with headcount, transfer requests,
-- and profile change requests.
--
-- A POSITION is a budgeted seat: "Senior Developer, Engineering, Hyderabad,
-- 3 seats". Requisitions and headcount reports can be honest about vacancies
-- once seats exist. A TRANSFER is a requested assignment change (department /
-- location / manager / designation) that goes through approval and lands as
-- changeAssignment() on its effective date. A PROFILE CHANGE REQUEST is an
-- employee proposing an edit to a field they may not write directly; HR
-- approves and the edit lands through updateEmployee(), audited as usual.

CREATE TABLE IF NOT EXISTS positions (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  code          text NOT NULL,
  title         text NOT NULL,
  department    text NOT NULL,
  designation   text NOT NULL,
  location_code text,
  grade_code    text,
  reports_to_position_id uuid,
  seats         int  NOT NULL DEFAULT 1 CHECK (seats >= 0),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, reports_to_position_id) REFERENCES positions (tenant_id, id)
);
ALTER TABLE employee_assignments ADD COLUMN IF NOT EXISTS position_id uuid;

CREATE TABLE IF NOT EXISTS transfer_requests (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL,
  effective_from date NOT NULL,
  department    text,                                -- NULL = unchanged
  designation   text,
  location_code text,
  manager_employee_id uuid,
  position_id   uuid,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','applied')),
  approval_request_id uuid,
  requested_by_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS transfer_requests_one_live_idx ON transfer_requests (tenant_id, employee_id) WHERE status IN ('pending','approved');

CREATE TABLE IF NOT EXISTS profile_change_requests (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL,
  changes       jsonb NOT NULL,                      -- EmployeePatch subset
  evidence_document_id uuid,
  note          text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by_user_id uuid,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS profile_change_requests_pending_idx ON profile_change_requests (tenant_id, status) WHERE status = 'pending';

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['positions','transfer_requests','profile_change_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
