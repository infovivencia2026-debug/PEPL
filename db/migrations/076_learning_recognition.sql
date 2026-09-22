-- Learning and recognition (blueprint C3).
--
-- Learning-lite: a course is a title, a mode (online link, in-house session,
-- external), an optional validity (a certification that expires) and a
-- mandatory flag with an audience. A nomination is one person on one course
-- with a due date; completion carries a score, a certificate document and,
-- for expiring courses, a valid-until date that feeds the compliance view.
-- Recognition: peer-to-peer badges with optional points; points are a
-- balance that payroll can pay out or a voucher can redeem.

CREATE TABLE IF NOT EXISTS courses (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  code          text NOT NULL,
  title         text NOT NULL,
  description   text,
  mode          text NOT NULL DEFAULT 'online' CHECK (mode IN ('online','classroom','external','self_paced')),
  link          text,
  duration_min  int,
  mandatory     boolean NOT NULL DEFAULT false,
  audience      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { departments: [], designations: [], joinedAfter: 'YYYY-MM-DD' } ; {} = everyone when mandatory
  validity_months int,                                 -- NULL = never expires
  due_days      int  NOT NULL DEFAULT 30,              -- after nomination
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS course_nominations (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  course_id     uuid NOT NULL,
  employee_id   uuid NOT NULL,
  nominated_by_user_id uuid,
  nominated_at  timestamptz NOT NULL DEFAULT now(),
  due_on        date NOT NULL,
  status        text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','completed','failed','waived')),
  started_at    timestamptz,
  completed_at  timestamptz,
  score         int CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  certificate_document_id uuid,
  valid_until   date,
  note          text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, course_id) REFERENCES courses (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS course_nominations_one_open_idx ON course_nominations (tenant_id, course_id, employee_id) WHERE status IN ('assigned','in_progress');
CREATE INDEX IF NOT EXISTS course_nominations_employee_idx ON course_nominations (tenant_id, employee_id);

CREATE TABLE IF NOT EXISTS recognition_badges (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  name        text NOT NULL,
  description text,
  points      int  NOT NULL DEFAULT 0 CHECK (points >= 0),
  manager_only boolean NOT NULL DEFAULT false,       -- some badges only a manager may give
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS recognitions (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  badge_id      uuid NOT NULL,
  to_employee_id uuid NOT NULL,
  from_user_id  uuid NOT NULL,
  message       text NOT NULL,
  points        int  NOT NULL DEFAULT 0,
  visibility    text NOT NULL DEFAULT 'company' CHECK (visibility IN ('company','team','private')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, badge_id) REFERENCES recognition_badges (tenant_id, id),
  FOREIGN KEY (tenant_id, to_employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS recognitions_feed_idx ON recognitions (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS points_ledger (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  delta       int  NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('recognition','redemption','adjustment','payout')),
  ref_id      uuid,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['courses','course_nominations','recognition_badges','recognitions','points_ledger'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  EXECUTE format('REVOKE UPDATE, DELETE ON points_ledger FROM %I', app_role);
END $$;
