-- Projects, allocations and timesheets.
--
-- A project is something hours are booked to: a client engagement, an
-- internal initiative, a school, a shoot, a site. People are allocated to it
-- (with a role and a percentage, effective-dated), book hours against it by
-- day, and submit a week at a time. The manager approves the week; approved
-- hours are what reports and billing see. Billable is a property of the
-- project, overridable per entry.

CREATE TABLE IF NOT EXISTS projects (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  code            text NOT NULL,
  name            text NOT NULL,
  client          text,
  kind            text NOT NULL DEFAULT 'client' CHECK (kind IN ('client','internal','site','batch','other')),
  owner_employee_id uuid,
  starts_on       date,
  ends_on         date,
  budget_hours    numeric(9,1),
  billable        boolean NOT NULL DEFAULT true,
  bill_rate_paise_per_hour bigint,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','closed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS project_allocations (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL,
  employee_id     uuid NOT NULL,
  role            text,
  percent         int NOT NULL DEFAULT 100 CHECK (percent BETWEEN 1 AND 100),
  starts_on       date NOT NULL DEFAULT CURRENT_DATE,
  ends_on         date,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS project_allocations_employee_idx ON project_allocations (tenant_id, employee_id) WHERE ends_on IS NULL;

-- One row per person per week, holding the state of that week's entries.
CREATE TABLE IF NOT EXISTS timesheets (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL,
  week_start      date NOT NULL,                        -- always a Monday
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','approved','rejected')),
  submitted_at    timestamptz,
  decided_at      timestamptz,
  decided_by_user_id uuid,
  comment         text,
  approval_request_id uuid,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_id, week_start),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS timesheet_entries (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  timesheet_id    uuid NOT NULL,
  project_id      uuid NOT NULL,
  work_date       date NOT NULL,
  hours           numeric(4,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  billable        boolean NOT NULL,
  note            text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, timesheet_id) REFERENCES timesheets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  UNIQUE (tenant_id, timesheet_id, project_id, work_date)
);
CREATE INDEX IF NOT EXISTS timesheet_entries_project_idx ON timesheet_entries (tenant_id, project_id, work_date);

-- The daily work log: what got done, what is blocked, what is next. Free text
-- per day, optionally tied to a project. Visible to the person and their manager.
CREATE TABLE IF NOT EXISTS work_logs (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL,
  work_date       date NOT NULL,
  project_id      uuid,
  done            text NOT NULL,
  blockers        text,
  next_plan       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_id, work_date, project_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['projects','project_allocations','timesheets','timesheet_entries','work_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
