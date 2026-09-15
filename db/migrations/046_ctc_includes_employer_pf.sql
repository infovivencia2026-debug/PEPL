-- Indian offers quote CTC, and CTC includes the employer's PF contribution.
-- A structure marked this way hands out GROSS = CTC − employer PF, with the
-- balance line absorbing the difference, so the number on the offer letter
-- and the number payroll splits are the same number.
ALTER TABLE salary_structures ADD COLUMN IF NOT EXISTS ctc_includes_employer_pf boolean NOT NULL DEFAULT false;
