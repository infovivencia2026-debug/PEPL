-- Approval policies, delegation, and the vocabulary the chains need.
--
-- The chains have always been a fixed vocabulary (right) chosen by one setting
-- per module (too little): a company that wants leave over five days to reach
-- HR, or a hike over 20% to reach finance, or a different chain for one
-- department, needed a code change. And "manager is on leave" meant a stuck
-- request. A POLICY picks the chain from the entity, the subject's department
-- and the size of the ask; a DELEGATION redirects a person's steps for a
-- while; the step roles dept_head and finance now have a way to resolve.
CREATE TABLE IF NOT EXISTS approval_policies (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  entity_type   text NOT NULL,                       -- 'leave', 'compensation', 'attendance_correction', …
  chain_code    text NOT NULL CHECK (chain_code IN ('manager','manager_then_hr','hr_only','manager_hr_finance','manager_dept_head','dept_head_hr')),
  -- The policy applies when magnitude >= threshold (days of leave, paise of
  -- hike, …). NULL applies to everything of the type. The largest satisfied
  -- threshold wins, so "over 5 days" beats "any leave".
  min_magnitude numeric(16,2),
  -- Department code from org_units; NULL is company-wide. A department policy
  -- beats a company-wide one at the same threshold.
  department_code text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  retired_at    timestamptz,
  created_by_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS approval_policies_lookup_idx ON approval_policies (tenant_id, entity_type, status);

CREATE TABLE IF NOT EXISTS approval_delegations (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  from_user_id  uuid NOT NULL,
  to_user_id    uuid NOT NULL,
  from_date     date NOT NULL,
  to_date       date NOT NULL,
  reason        text,
  created_by_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, from_user_id) REFERENCES app_users (tenant_id, id),
  FOREIGN KEY (tenant_id, to_user_id)   REFERENCES app_users (tenant_id, id),
  CHECK (to_date >= from_date),
  CHECK (from_user_id <> to_user_id)
);
CREATE INDEX IF NOT EXISTS approval_delegations_lookup_idx ON approval_delegations (tenant_id, from_user_id, from_date, to_date);

-- A step records who it was routed FROM when a delegation redirected it, so
-- the trail says "approved by B for A", not just "approved by B".
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS delegated_from_user_id uuid;
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- The two chain codes above that did not exist before.
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_chain_code_check;

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
        t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approval_policies','approval_delegations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON approval_policies TO %I', app_role);
  EXECUTE format('REVOKE DELETE ON approval_policies FROM %I', app_role);
  -- A delegation is a temporary arrangement; ending it early is a delete.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON approval_delegations TO %I', app_role);
END $$;
