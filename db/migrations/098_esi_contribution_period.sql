-- ESI eligibility is decided once per contribution period, not once per month.
--
-- The two periods are April-September and October-March. Whether someone is
-- covered is settled at the START of a period against the wage ceiling, and it
-- HOLDS UNTIL THE PERIOD ENDS even if their wages rise above the ceiling in
-- between. A mid-year raise does not end their cover; it ends at the next
-- period boundary.
--
-- PEPL re-tested the ceiling every month, so a raise in, say, July silently
-- dropped that person out of ESI from July — losing them cover they were
-- legally entitled to for the rest of the period, and understating the
-- employer's contribution on the return.
--
-- The engine reads ONLY payroll_inputs, so this is resolved at freeze and
-- written as a value, like every other input. A locked run keeps the answer it
-- was locked with.

ALTER TABLE payroll_inputs
  ADD COLUMN IF NOT EXISTS esi_covered_period boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN payroll_inputs.esi_covered_period IS
  'True when this employee was already ESI-covered earlier in the current contribution period, so the wage ceiling must not be re-tested this month.';
