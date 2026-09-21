-- Two constraints found by the first tests of 055.
--
-- A week can be submitted more than once (sent back, fixed, resubmitted), and
-- approval_requests allows one request per (entity_type, entity_id). Each
-- submission therefore gets its own id, recorded on the timesheet alongside
-- the request it raised.
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS submission_no int NOT NULL DEFAULT 0;

-- NULLs are distinct in a UNIQUE constraint, so a work log with no project
-- could be written twice for the same day. NULLS NOT DISTINCT makes the
-- "one log per person per day per project" rule hold for "no project" too.
ALTER TABLE work_logs DROP CONSTRAINT IF EXISTS work_logs_tenant_id_employee_id_work_date_project_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS work_logs_day_idx
  ON work_logs (tenant_id, employee_id, work_date, project_id) NULLS NOT DISTINCT;
