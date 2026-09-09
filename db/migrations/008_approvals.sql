-- Approvals. See docs/architecture/leave-attendance-ops.md §6.
--
-- ONE generic mechanism that every module routes through, which is what makes the
-- universal inbox a single query rather than nine screens a manager learns to ignore.

CREATE TABLE IF NOT EXISTS approval_requests (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  entity_type         text NOT NULL,   -- leave | attendance_correction | compensation | ...
  entity_id           uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  subject_employee_id uuid,
  chain_code          text NOT NULL,
  current_step        int NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','sent_back','cancelled','withdrawn')),
  title               text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS approval_pending_idx
  ON approval_requests (tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS approval_steps (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  approval_request_id uuid NOT NULL,
  step_no             int NOT NULL,
  approver_user_id    uuid,
  approver_role       text,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','skipped')),
  decided_at          timestamptz,
  PRIMARY KEY (tenant_id, approval_request_id, step_no),
  FOREIGN KEY (tenant_id, approval_request_id) REFERENCES approval_requests (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS approval_step_inbox_idx
  ON approval_steps (tenant_id, approver_user_id, status);

-- Append-only: the decision trail is evidence.
CREATE TABLE IF NOT EXISTS approval_actions (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  approval_request_id uuid NOT NULL,
  step_no             int NOT NULL,
  actor_user_id       uuid NOT NULL,
  action              text NOT NULL CHECK (action IN
                        ('approve','reject','send_back','comment','delegate','withdraw')),
  comment             text,
  acted_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, approval_request_id) REFERENCES approval_requests (tenant_id, id)
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['approval_requests','approval_steps','approval_actions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  EXECUTE format('REVOKE UPDATE, DELETE ON approval_actions FROM %I', app_role);
END $$;
