-- Bitemporal employment facts. See docs/architecture/data-model.md §3.
--
--   effective_from / effective_to   VALID time      — when the fact was true in the world
--   recorded_at                     TRANSACTION time — when we learned it
--   superseded_at                   when we stopped believing it (NULL = current belief)
--
-- Rows are never UPDATEd except to set superseded_at (and to close effective_to).
--   a CHANGE     closes the prior row and inserts a new one   (promotion from 1 Oct)
--   a CORRECTION supersedes the wrong row and inserts a replacement with the same
--                effective_from                               (we entered it wrong)
--
-- This is what lets a locked payroll run answer "what did we BELIEVE this person's
-- salary was on the day we locked?" — unobtainable from valid time alone.

-- Wave 1 created employee_assignments without the "who and why" columns every
-- effective-dated change must carry.
ALTER TABLE employee_assignments
  ADD COLUMN IF NOT EXISTS changed_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS change_reason      text;

-- History is never deleted; a wrong row is superseded.
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('REVOKE DELETE ON employee_assignments FROM %I', app_role);
END $$;

-- No two BELIEVED assignments may overlap in valid time for one employee.
-- The partial predicate is what makes corrections possible: a superseded row may
-- overlap its replacement, because we no longer believe it.
ALTER TABLE employee_assignments
  ADD CONSTRAINT assignment_no_overlap
  EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL);

CREATE TABLE IF NOT EXISTS compensation_records (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id        uuid NOT NULL,
  annual_ctc_paise   bigint NOT NULL CHECK (annual_ctc_paise >= 0),
  -- resolved monthly amounts in paise, e.g. {"basic":5000000,"hra":2000000}
  components         jsonb NOT NULL DEFAULT '{}'::jsonb,
  pay_frequency      text NOT NULL DEFAULT 'monthly',
  effective_from     date NOT NULL,
  effective_to       date,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  superseded_at      timestamptz,
  changed_by_user_id uuid,
  change_reason      text,
  approved_by_user_id uuid,
  approved_at        timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

ALTER TABLE compensation_records
  ADD CONSTRAINT compensation_no_overlap
  EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL);

CREATE INDEX IF NOT EXISTS compensation_tenant_employee_idx
  ON compensation_records (tenant_id, employee_id, effective_from DESC);

ALTER TABLE compensation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE compensation_records FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON compensation_records;
CREATE POLICY tenant_isolation ON compensation_records
  USING      (tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON compensation_records TO %I', app_role);
  -- History is never deleted; a wrong row is superseded.
  EXECUTE format('REVOKE DELETE ON compensation_records FROM %I', app_role);
END $$;

-- ---------------------------------------------------------------------------
-- The query layer. Application code must NEVER hand-write the four-predicate
-- join; there are exactly two accessors.
-- ---------------------------------------------------------------------------

-- security_invoker makes the view run with the CALLER's privileges, so RLS
-- applies to the app role. Without it the view would execute as its owner —
-- and FORCE ROW LEVEL SECURITY means the owner sees nothing either.
CREATE OR REPLACE VIEW current_employee_profile
WITH (security_invoker = true) AS
SELECT e.tenant_id,
       e.id AS employee_id,
       e.employee_number,
       e.first_name,
       e.last_name,
       e.status,
       e.date_of_joining,
       a.department,
       a.designation,
       a.effective_from AS assignment_effective_from,
       c.annual_ctc_paise,
       c.components
  FROM employees e
  LEFT JOIN employee_assignments a
         ON (a.tenant_id, a.employee_id) = (e.tenant_id, e.id)
        AND a.superseded_at IS NULL
        AND daterange(a.effective_from, a.effective_to, '[)') @> CURRENT_DATE
  LEFT JOIN compensation_records c
         ON (c.tenant_id, c.employee_id) = (e.tenant_id, e.id)
        AND c.superseded_at IS NULL
        AND daterange(c.effective_from, c.effective_to, '[)') @> CURRENT_DATE;

-- Full bitemporal accessor.
--   as_of_valid  — which real-world date are we asking about
--   as_known_at  — what did we believe at that moment
CREATE OR REPLACE FUNCTION employee_profile_at(
  p_employee  uuid,
  as_of_valid date,
  as_known_at timestamptz DEFAULT now()
) RETURNS TABLE (
  employee_id      uuid,
  employee_number  text,
  first_name       text,
  last_name        text,
  department       text,
  designation      text,
  annual_ctc_paise bigint,
  components       jsonb
)
LANGUAGE sql STABLE AS $$
  SELECT e.id,
         e.employee_number,
         e.first_name,
         e.last_name,
         a.department,
         a.designation,
         c.annual_ctc_paise,
         c.components
    FROM employees e
    LEFT JOIN employee_assignments a
           ON (a.tenant_id, a.employee_id) = (e.tenant_id, e.id)
          AND a.effective_from <= as_of_valid
          AND (a.effective_to IS NULL OR a.effective_to > as_of_valid)
          AND a.recorded_at <= as_known_at
          AND (a.superseded_at IS NULL OR a.superseded_at > as_known_at)
    LEFT JOIN compensation_records c
           ON (c.tenant_id, c.employee_id) = (e.tenant_id, e.id)
          AND c.effective_from <= as_of_valid
          AND (c.effective_to IS NULL OR c.effective_to > as_of_valid)
          AND c.recorded_at <= as_known_at
          AND (c.superseded_at IS NULL OR c.superseded_at > as_known_at)
   WHERE e.id = p_employee;
$$;

GRANT SELECT ON current_employee_profile TO PUBLIC;
