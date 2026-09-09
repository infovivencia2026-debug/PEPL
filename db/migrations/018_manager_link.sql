-- The reporting line. Effective-dated like every other assignment fact, so
-- "who was this person's manager in August" stays answerable after a re-org.
ALTER TABLE employee_assignments
  ADD COLUMN IF NOT EXISTS manager_employee_id uuid,
  ADD COLUMN IF NOT EXISTS location            text,
  ADD COLUMN IF NOT EXISTS grade               text,
  ADD COLUMN IF NOT EXISTS employment_type     text NOT NULL DEFAULT 'full_time';

CREATE INDEX IF NOT EXISTS assignment_manager_idx
  ON employee_assignments (tenant_id, manager_employee_id)
  WHERE superseded_at IS NULL;

-- app_users.employee_id links a login to a person; the manager chain is resolved
-- through it, so it needs a lookup path.
CREATE INDEX IF NOT EXISTS app_users_employee_idx ON app_users (tenant_id, employee_id);
