-- Year-to-date facts for TDS, frozen as values.
--
-- computeTds could take earned-to-date and deducted-to-date since it was
-- written, and nothing ever passed them: every month was projected as "this
-- month times the months left" from a standing start. A joiner in October, a
-- hike in August or a bonus in March was taxed wrong, and the March true-up
-- real payroll relies on never happened.
--
-- Resolved at freeze from LOCKED, non-superseded runs of the same fiscal year,
-- following the invariant: the engine reads payroll_inputs and nothing else.
-- months_remaining comes from the PERIOD, not the wall clock — September's run
-- processed in October is still September's.
ALTER TABLE payroll_inputs
  ADD COLUMN IF NOT EXISTS ytd_taxable_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ytd_tds_paise     bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS months_remaining  int    NOT NULL DEFAULT 12
    CHECK (months_remaining BETWEEN 1 AND 12);
