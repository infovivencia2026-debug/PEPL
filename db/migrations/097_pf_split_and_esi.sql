-- The employer's PF contribution is not one number, and ESI does not round the
-- way everything else does.
--
-- PF: the employer's 12% is split at source. 8.33% of PF wages goes to the
-- PENSION fund (EPS), capped at the pension ceiling — currently 8.33% of
-- ₹15,000, i.e. ₹1,250 — and whatever is left of the 12% goes to the provident
-- fund itself. EDLI is a further 0.5% of PF wages, also capped at the ceiling.
--
-- PEPL booked the whole 12% as a single PF_ER line. The employee's passbook is
-- unaffected, but the ECR return has separate columns for EPF and EPS and the
-- employer's true cost is understated by the EDLI. A return filed from these
-- numbers is wrong in a way that is tedious to unpick later.
--
-- Rates live here, next to the ones they belong with, so a change is an
-- effective-dated row rather than an edit to code — a locked payroll must keep
-- computing the way it did when it was locked.

ALTER TABLE statutory_configs
  ADD COLUMN IF NOT EXISTS eps_rate              numeric(6,4) NOT NULL DEFAULT 0.0833,
  ADD COLUMN IF NOT EXISTS eps_wage_ceiling_paise bigint      NOT NULL DEFAULT 1500000,
  ADD COLUMN IF NOT EXISTS edli_rate             numeric(6,4) NOT NULL DEFAULT 0.0050,
  ADD COLUMN IF NOT EXISTS edli_wage_ceiling_paise bigint     NOT NULL DEFAULT 1500000;

COMMENT ON COLUMN statutory_configs.eps_rate IS
  'Pension share of the employer 12%. The rest goes to EPF. Capped at eps_wage_ceiling_paise.';
COMMENT ON COLUMN statutory_configs.edli_rate IS
  'Employees Deposit Linked Insurance, an employer cost on top of the 12%.';

-- ESI is rounded UP to the next rupee, per ESI (General) Regulation 40 — not to
-- the nearest, which is what every other component does. On a 0.75% employee
-- share the difference is under a rupee per person per month and it is still
-- wrong on the return.
COMMENT ON TABLE statutory_configs IS
  'Effective-dated statutory rates. ESI contributions round UP (Reg 40); everything else rounds to the nearest rupee.';

-- Which half-year ESI contribution period a date falls in. Eligibility is
-- decided at the START of a period and holds until it ends, even if wages rise
-- above the threshold in between — an employee cannot be dropped from ESI
-- mid-period.
CREATE OR REPLACE FUNCTION esi_contribution_period(on_date date)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN EXTRACT(MONTH FROM on_date) BETWEEN 4 AND 9
      THEN EXTRACT(YEAR FROM on_date)::text || '-AS'   -- April to September
    WHEN EXTRACT(MONTH FROM on_date) >= 10
      THEN EXTRACT(YEAR FROM on_date)::text || '-OM'   -- October to March
    ELSE (EXTRACT(YEAR FROM on_date) - 1)::text || '-OM'
  END
$$;

COMMENT ON FUNCTION esi_contribution_period(date) IS
  'Half-year ESI contribution period: April-September and October-March. Eligibility is fixed at its start.';
