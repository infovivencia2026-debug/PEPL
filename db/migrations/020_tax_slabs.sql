-- Income tax slabs. GLOBAL reference data with effective dates, like every other
-- statutory rate: a Finance Act change is an INSERT, never a code deploy, and it
-- never retroactively alters a locked payroll run.
--
-- IMPORTANT: the rows seeded here are representative and MUST be reconciled
-- against the Finance Act in force before any real payroll is paid. The schema
-- is the deliverable; the numbers are data a compliance owner signs off.

CREATE TABLE IF NOT EXISTS tax_slabs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regime             text NOT NULL CHECK (regime IN ('old','new')),
  fiscal_year        text NOT NULL,                  -- '2026-27'
  income_from_paise  bigint NOT NULL,
  income_to_paise    bigint,                         -- NULL = no upper bound
  rate               numeric(6,4) NOT NULL,
  UNIQUE (regime, fiscal_year, income_from_paise)
);

CREATE TABLE IF NOT EXISTS tax_rules (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regime                   text NOT NULL CHECK (regime IN ('old','new')),
  fiscal_year              text NOT NULL,
  standard_deduction_paise bigint NOT NULL DEFAULT 0,
  -- section 87A: full rebate when taxable income is at or below the threshold
  rebate_limit_paise       bigint NOT NULL DEFAULT 0,
  rebate_max_paise         bigint NOT NULL DEFAULT 0,
  cess_rate                numeric(6,4) NOT NULL DEFAULT 0.04,
  surcharge_bands          jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (regime, fiscal_year)
);

CREATE INDEX IF NOT EXISTS tax_slab_lookup_idx ON tax_slabs (regime, fiscal_year, income_from_paise);

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT SELECT ON tax_slabs, tax_rules TO %I', app_role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON tax_slabs, tax_rules FROM %I', app_role);
END $$;
