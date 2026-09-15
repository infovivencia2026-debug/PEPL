-- A payslip's DELIVERY is not its pay.
--
-- `payslips_immutable` rejects every UPDATE once the run is locked, which is
-- exactly right for money and exactly wrong for `distributed_at`: the payslip
-- can only be sent AFTER the run is locked, so recording that it was sent was
-- impossible. Same shape as the retention job against attendance_punches —
-- the table stays immutable, and the two delivery columns are the named
-- exception, checked here rather than trusted to the caller.
CREATE OR REPLACE FUNCTION reject_locked_payslip_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM payroll_runs
   WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
     AND id        = COALESCE(NEW.run_id,   OLD.run_id);

  IF s = 'locked' THEN
    -- The only change a locked payslip accepts: whether, and how, it was sent.
    IF TG_OP = 'UPDATE'
       AND NEW.tenant_id       IS NOT DISTINCT FROM OLD.tenant_id
       AND NEW.id              IS NOT DISTINCT FROM OLD.id
       AND NEW.run_id          IS NOT DISTINCT FROM OLD.run_id
       AND NEW.employee_id     IS NOT DISTINCT FROM OLD.employee_id
       AND NEW.gross_paise     IS NOT DISTINCT FROM OLD.gross_paise
       AND NEW.deductions_paise IS NOT DISTINCT FROM OLD.deductions_paise
       AND NEW.net_paise       IS NOT DISTINCT FROM OLD.net_paise
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'payroll run % is locked; create a revision instead',
      COALESCE(NEW.run_id, OLD.run_id)
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS payslips_immutable ON payslips;
CREATE TRIGGER payslips_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON payslips
  FOR EACH ROW EXECUTE FUNCTION reject_locked_payslip_write();
