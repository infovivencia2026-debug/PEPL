-- Professional tax exemptions that depend on who the employee is.
--
-- Maharashtra exempts WOMEN from professional tax up to a monthly salary of
-- ₹25,000. PEPL applied the general slab to everyone and the reference table
-- said so in a note — an honest warning, but the deduction was still wrong on
-- every affected payslip, and a wrong PT deduction is money taken from
-- someone who did not owe it.
--
-- The engine reads ONLY payroll_inputs, so gender is resolved at freeze and
-- written as a value like everything else. A locked run keeps the answer it
-- was locked with, which matters here: the exemption threshold can change.

ALTER TABLE payroll_inputs
  ADD COLUMN IF NOT EXISTS gender text;

COMMENT ON COLUMN payroll_inputs.gender IS
  'Copied from the employee at freeze. Used only for statutory exemptions that depend on it, such as the Maharashtra professional tax exemption for women.';

-- Exemptions are data, not code, so a state changing its threshold is a row.
CREATE TABLE IF NOT EXISTS pt_exemptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code     text NOT NULL,
  -- Matches payroll_inputs.gender; NULL means the exemption is not gendered.
  gender         text,
  -- Exempt while monthly gross is at or below this.
  gross_upto_paise bigint NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  note           text,
  UNIQUE (state_code, gender, effective_from)
);

COMMENT ON TABLE pt_exemptions IS
  'Who does not pay professional tax despite falling in a slab. Reference data, like pt_slabs.';

INSERT INTO pt_exemptions (state_code, gender, gross_upto_paise, effective_from, note)
VALUES ('MH', 'female', 2500000, DATE '2015-04-01',
        'Maharashtra exempts women earning up to Rs 25,000 a month.')
ON CONFLICT (state_code, gender, effective_from) DO NOTHING;
