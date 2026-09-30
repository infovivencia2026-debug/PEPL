-- A locked payroll run must be unwritable from every direction -- including out.
--
-- reject_locked_payroll_write() found the run with COALESCE(NEW.run_id, OLD.run_id).
-- On an UPDATE that is NEW.run_id: the row was judged by where it was GOING, never by
-- where it LIVED. `UPDATE payroll_lines SET run_id = <an open run> WHERE run_id = <a
-- locked run>` therefore passed, silently removing lines from a locked run and
-- changing its totals and its payslips -- the one thing the trigger exists to stop.
-- (Moving a row INTO a locked run was already refused, which hid the gap.)
--
-- The rule is now: an UPDATE or DELETE is judged by the run the row belonged to, and an
-- INSERT or UPDATE by the run it will belong to. Either being locked rejects the write.
-- Payslips keep 049's one exception -- the two delivery columns of a locked payslip --
-- which still requires run_id to be unchanged, so it can never be used to move a row.

CREATE OR REPLACE FUNCTION run_is_locked(p_tenant uuid, p_run uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM payroll_runs
                  WHERE tenant_id = p_tenant AND id = p_run AND status = 'locked')
$$;

CREATE OR REPLACE FUNCTION reject_locked_payroll_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP IN ('UPDATE','DELETE') AND run_is_locked(OLD.tenant_id, OLD.run_id))
     OR (TG_OP IN ('INSERT','UPDATE') AND run_is_locked(NEW.tenant_id, NEW.run_id)) THEN
    RAISE EXCEPTION 'payroll run % is locked; create a revision instead',
      CASE WHEN TG_OP = 'INSERT' THEN NEW.run_id
           WHEN run_is_locked(OLD.tenant_id, OLD.run_id) THEN OLD.run_id
           ELSE NEW.run_id END
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION reject_locked_payslip_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Moving a payslip into a locked run is refused like any other write to it.
  IF TG_OP IN ('INSERT','UPDATE') AND run_is_locked(NEW.tenant_id, NEW.run_id) THEN
    -- The only change a locked payslip accepts: whether, and how, it was sent.
    IF TG_OP = 'UPDATE'
       AND NEW.tenant_id        IS NOT DISTINCT FROM OLD.tenant_id
       AND NEW.id               IS NOT DISTINCT FROM OLD.id
       AND NEW.run_id           IS NOT DISTINCT FROM OLD.run_id
       AND NEW.employee_id      IS NOT DISTINCT FROM OLD.employee_id
       AND NEW.gross_paise      IS NOT DISTINCT FROM OLD.gross_paise
       AND NEW.deductions_paise IS NOT DISTINCT FROM OLD.deductions_paise
       AND NEW.net_paise        IS NOT DISTINCT FROM OLD.net_paise
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'payroll run % is locked; create a revision instead', NEW.run_id
      USING ERRCODE = 'raise_exception';
  END IF;
  -- Leaving a locked run (a move or a delete) is refused outright.
  IF TG_OP IN ('UPDATE','DELETE') AND run_is_locked(OLD.tenant_id, OLD.run_id) THEN
    RAISE EXCEPTION 'payroll run % is locked; create a revision instead', OLD.run_id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
