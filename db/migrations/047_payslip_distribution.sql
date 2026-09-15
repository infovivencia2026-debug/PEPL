-- Payslip distribution.
--
-- The PDF has existed since payroll; nobody sent it. An employee who cannot
-- see PEPL — a factory worker, someone who has left — waits for an email that
-- was never written. This records the fact of sending, once per payslip, so a
-- re-run of the job never sends a second copy and support can answer "did she
-- get it?" from a row rather than from a mailbox.
ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS distributed_at timestamptz,
  ADD COLUMN IF NOT EXISTS distribution_error text;

CREATE INDEX IF NOT EXISTS payslip_undistributed_idx
  ON payslips (tenant_id, run_id) WHERE distributed_at IS NULL;
