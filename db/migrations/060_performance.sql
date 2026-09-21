-- Performance: goals with weights and check-ins, review cycles with a
-- self → manager → calibration → acknowledgement appraisal, and performance
-- improvement plans.
--
-- A PIP is confidential WITHIN the tenant: the policy (not the service) limits
-- it to the employee, their current manager and HR/admin users, following the
-- tickets pattern — a forgotten WHERE clause cannot put one in a team list.

CREATE TABLE IF NOT EXISTS review_cycles (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  period_start     date NOT NULL,
  period_end       date NOT NULL CHECK (period_end >= period_start),
  self_review_due  date,
  manager_review_due date,
  rating_scale     int  NOT NULL DEFAULT 5 CHECK (rating_scale BETWEEN 3 AND 10),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','calibration','closed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS review_cycles_name_idx ON review_cycles (tenant_id, lower(name));

CREATE TABLE IF NOT EXISTS goals (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id      uuid NOT NULL,
  cycle_id         uuid,
  title            text NOT NULL,
  description      text,
  kpi              text,                        -- how it is measured
  target           text,                        -- '₹1.2 Cr', '95%', '12 releases'
  weight_pct       int  NOT NULL DEFAULT 0 CHECK (weight_pct BETWEEN 0 AND 100),
  due_on           date,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  progress_pct     int  NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  set_by_user_id   uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES review_cycles (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS goals_employee_idx ON goals (tenant_id, employee_id, status);

CREATE TABLE IF NOT EXISTS goal_checkins (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  goal_id          uuid NOT NULL,
  progress_pct     int  NOT NULL CHECK (progress_pct BETWEEN 0 AND 100),
  note             text NOT NULL,
  by_user_id       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, goal_id) REFERENCES goals (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS appraisals (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  cycle_id         uuid NOT NULL,
  employee_id      uuid NOT NULL,
  reviewer_employee_id uuid,                    -- the manager at cycle open; NULL = HR reviews
  status           text NOT NULL DEFAULT 'self_pending'
                   CHECK (status IN ('self_pending','manager_pending','calibration','acknowledgement','closed')),
  self_rating      int,
  self_comments    text,
  self_submitted_at timestamptz,
  manager_rating   int,
  manager_comments text,
  manager_submitted_at timestamptz,
  final_rating     int,
  calibration_note text,
  acknowledged_at  timestamptz,
  employee_comments text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, cycle_id, employee_id),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES review_cycles (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS appraisals_reviewer_idx ON appraisals (tenant_id, reviewer_employee_id, status);

CREATE TABLE IF NOT EXISTS pips (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id      uuid NOT NULL,
  opened_by_user_id uuid,
  reason           text NOT NULL,
  objectives       jsonb NOT NULL DEFAULT '[]',  -- [{ title, measure, due_on }]
  starts_on        date NOT NULL,
  review_on        date NOT NULL,
  ends_on          date NOT NULL CHECK (ends_on >= starts_on),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','extended','closed_success','closed_exit')),
  reviews          jsonb NOT NULL DEFAULT '[]',  -- [{ on, by_user_id, note, verdict }]
  outcome          text,
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pips_one_active_idx ON pips (tenant_id, employee_id) WHERE status IN ('active','extended');

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['review_cycles','goals','goal_checkins','appraisals','pips'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;

-- PIP confidentiality: the subject, their current manager, whoever opened it, HR and admins.
DROP POLICY IF EXISTS tenant_isolation ON pips;
CREATE POLICY tenant_isolation ON pips
  USING (
    tenant_id = current_tenant()
    AND (
      opened_by_user_id = current_app_user()
      OR EXISTS (SELECT 1 FROM app_users u WHERE u.tenant_id = pips.tenant_id AND u.id = current_app_user() AND u.employee_id = pips.employee_id)
      OR EXISTS (SELECT 1 FROM app_users u JOIN employee_assignments a
                   ON a.tenant_id = u.tenant_id AND a.manager_employee_id = u.employee_id AND a.effective_to IS NULL
                 WHERE u.tenant_id = pips.tenant_id AND u.id = current_app_user() AND a.employee_id = pips.employee_id)
      OR EXISTS (SELECT 1 FROM user_roles r WHERE r.tenant_id = pips.tenant_id AND r.user_id = current_app_user() AND r.role IN ('org_admin','hr_admin'))
    )
  )
  WITH CHECK (tenant_id = current_tenant());
