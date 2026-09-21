-- The employee record grows from six business columns to an HR master.
--
-- Everything here was missing and each absence cost a rule: no date of birth
-- means no retirement or gratuity eligibility; no location on the assignment
-- means one professional-tax state for a company with offices in two; no
-- grade means grade-scoped settings are decoration; no PF/ESI flags means
-- every employee is deducted whatever their eligibility.
--
-- Personal fields stay on `employees` (they describe the person); location
-- and grade go on `employee_assignments` (they describe the posting, and
-- change with it, effective-dated like department and designation).

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS date_of_birth      date,
  ADD COLUMN IF NOT EXISTS gender             text CHECK (gender IN ('female','male','other','undisclosed')),
  ADD COLUMN IF NOT EXISTS personal_email     text,
  ADD COLUMN IF NOT EXISTS work_email         text,
  ADD COLUMN IF NOT EXISTS phone              text,
  ADD COLUMN IF NOT EXISTS address            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS emergency_contact  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS employment_type    text NOT NULL DEFAULT 'permanent'
        CHECK (employment_type IN ('permanent','probation','contract','intern','consultant','part_time')),
  ADD COLUMN IF NOT EXISTS probation_end      date,
  ADD COLUMN IF NOT EXISTS confirmed_on       date,
  ADD COLUMN IF NOT EXISTS notice_period_days int NOT NULL DEFAULT 30 CHECK (notice_period_days >= 0),
  ADD COLUMN IF NOT EXISTS cost_centre        text,
  -- Statutory applicability is a fact about the person, not a company-wide assumption.
  ADD COLUMN IF NOT EXISTS pf_applicable      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS esi_applicable     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS custom_fields      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS photo_document_id  uuid,
  ADD COLUMN IF NOT EXISTS updated_at         timestamptz NOT NULL DEFAULT now();

-- One work email per company: it is what a login is derived from.
CREATE UNIQUE INDEX IF NOT EXISTS employees_work_email_idx
  ON employees (tenant_id, lower(work_email)) WHERE work_email IS NOT NULL;

ALTER TABLE employee_assignments
  ADD COLUMN IF NOT EXISTS location_code text,
  ADD COLUMN IF NOT EXISTS grade_code    text;
CREATE INDEX IF NOT EXISTS employee_assignments_location_idx
  ON employee_assignments (tenant_id, location_code) WHERE superseded_at IS NULL;

-- The company's own field definitions: label, type, whether required. The
-- values live in employees.custom_fields keyed by `key`.
CREATE TABLE IF NOT EXISTS employee_field_definitions (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  key        text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label      text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('text','number','date','boolean','select')),
  options    jsonb NOT NULL DEFAULT '[]'::jsonb,
  required   boolean NOT NULL DEFAULT false,
  self_editable boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key)
);
ALTER TABLE employee_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_field_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee_field_definitions;
CREATE POLICY tenant_isolation ON employee_field_definitions
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_field_definitions TO pepl_app;
