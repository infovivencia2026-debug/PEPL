-- Changes held for approval.
--
-- Leave was the only thing that went through an approval; a salary revision
-- or an attendance correction applied the moment someone with the permission
-- clicked. A PENDING CHANGE is the intended write, parked with the approval
-- request that decides it: approved → applied through the same module
-- function a direct write uses; rejected/withdrawn → never applied. The
-- payload is what the caller would have sent, so nothing is re-typed.
CREATE TABLE IF NOT EXISTS pending_changes (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  entity_type          text NOT NULL CHECK (entity_type IN ('compensation','attendance_correction')),
  subject_employee_id  uuid NOT NULL,
  payload              jsonb NOT NULL,
  approval_request_id  uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','withdrawn')),
  -- What applying it produced (a record id, a result), for the trail.
  result               jsonb,
  applied_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subject_employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, approval_request_id) REFERENCES approval_requests (tenant_id, id),
  UNIQUE (tenant_id, approval_request_id)
);

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE pending_changes ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE pending_changes FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON pending_changes';
  EXECUTE 'CREATE POLICY tenant_isolation ON pending_changes
             USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON pending_changes TO %I', app_role);
  EXECUTE format('REVOKE DELETE ON pending_changes FROM %I', app_role);
END $$;
