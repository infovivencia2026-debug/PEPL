-- Role administration.
--
-- Custom roles could be created and never edited, retired or assigned: roles
-- were set once, at user creation, by code. And scope was company / reports /
-- self — a "Chennai HR" who sees only Chennai could not exist.
--
-- `department` scope: the role sees the people currently assigned to the
-- listed departments. It is resolved into the same reportIds set the manager
-- scope uses, so every scope check in the codebase already honours it.
ALTER TABLE custom_roles DROP CONSTRAINT IF EXISTS custom_roles_data_scope_check;
ALTER TABLE custom_roles
  ADD CONSTRAINT custom_roles_data_scope_check CHECK (data_scope IN ('all','reports','self','department')),
  ADD COLUMN IF NOT EXISTS department_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS granted_by_user_id uuid;

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  -- Assigning and removing roles is the point; the app role needs DELETE here.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON custom_roles TO %I', app_role);
  EXECUTE format('REVOKE DELETE ON custom_roles FROM %I', app_role);
END $$;
