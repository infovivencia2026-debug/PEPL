# PEPL — Payroll architecture

The most important rule in the system:

> **The payroll engine never reads `attendance_punches`, `daily_attendance` or `leave_ledger`. It reads `payroll_inputs`, which is written once per run revision by an explicit, auditable freeze step.**

Everything below follows from that.

---

## 1. Pipeline

```
raw attendance ──► attendance processing ──► attendance period CLOSED
                                                     │
leave ledger ────────────────────────────────────────┤
compensation (effective on period_end) ──────────────┤
statutory config (version effective in period) ──────┤
one-off inputs (bonus, arrear, advance, adjustment) ─┤
                                                     ▼
                                            PAYROLL INPUTS (frozen)
                                                     │
                                          PAYROLL CALCULATION
                                                     │
                                              VALIDATION
                                                     │
                                           REVIEW / APPROVAL
                                                     │
                                                  LOCK
                                                     │
                                    bank file  +  payslip PDFs
```

A run can move backwards only from `calculated`/`validated` to `draft` (unfreeze). Once `locked`, it can never be edited — only superseded by a new revision.

---

## 2. Schema

```sql
CREATE TYPE payroll_run_status AS ENUM
  ('draft','inputs_frozen','calculated','validated','approved','locked','cancelled');

CREATE TABLE payroll_periods (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  period_start date NOT NULL, period_end date NOT NULL,
  pay_date date NOT NULL,
  label text NOT NULL,                      -- '2026-09'
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, period_start)
);

CREATE TABLE payroll_runs (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL,
  revision int NOT NULL DEFAULT 1,
  supersedes_run_id uuid,                   -- revision N+1 points at N
  status payroll_run_status NOT NULL DEFAULT 'draft',
  employee_count int, gross_paise bigint, deductions_paise bigint, net_paise bigint,
  frozen_at timestamptz, calculated_at timestamptz,
  approved_by_user_id uuid, approved_at timestamptz,
  locked_by_user_id uuid, locked_at timestamptz,
  correction_reason text,                   -- required when revision > 1
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, period_id, revision),
  CHECK (revision = 1 OR correction_reason IS NOT NULL)
);
```

### 2.1 Frozen inputs

One row per employee per run. Written once at freeze; never updated.

```sql
CREATE TABLE payroll_inputs (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL, employee_id uuid NOT NULL,

  -- attendance-derived
  calendar_days      numeric(5,2) NOT NULL,
  payable_days       numeric(5,2) NOT NULL,
  lop_days           numeric(5,2) NOT NULL DEFAULT 0,
  paid_leave_days    numeric(5,2) NOT NULL DEFAULT 0,
  ot_minutes         int NOT NULL DEFAULT 0,

  -- compensation snapshot (values, not references)
  structure_id       uuid NOT NULL,
  compensation_record_id uuid NOT NULL,
  monthly_components jsonb NOT NULL,        -- {"basic":5000000,"hra":2000000,...} paise

  -- statutory snapshot
  statutory_config_id uuid NOT NULL,
  state_code text NOT NULL,
  pf_applicable boolean NOT NULL, esi_applicable boolean NOT NULL,
  tax_regime text NOT NULL,                 -- old | new

  -- one-offs
  adhoc jsonb NOT NULL DEFAULT '[]',        -- [{"code":"BONUS","amount":2500000,"note":"..."}]

  -- joiner/leaver
  joined_mid_period boolean NOT NULL DEFAULT false,
  exited_mid_period boolean NOT NULL DEFAULT false,
  fnf boolean NOT NULL DEFAULT false,

  frozen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, run_id, employee_id)
);
```

`monthly_components` stores **resolved amounts**, not a pointer to a structure that may later change. That is what makes a locked run reproducible five years later even after the structure is edited.

### 2.2 Output

```sql
CREATE TABLE payroll_lines (
  tenant_id uuid NOT NULL, id bigserial,
  run_id uuid NOT NULL, employee_id uuid NOT NULL,
  component_code text NOT NULL,             -- BASIC, HRA, PF_EE, PF_ER, ESI_EE, PT, TDS, LOP, OT, ARREAR
  component_type text NOT NULL,             -- earning|deduction|employer_contribution|informational
  amount_paise bigint NOT NULL,
  calc_note jsonb,                          -- inputs + formula trace for this line
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, run_id, employee_id, component_code)
);

CREATE TABLE payslips (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL, employee_id uuid NOT NULL,
  gross_paise bigint NOT NULL, deductions_paise bigint NOT NULL, net_paise bigint NOT NULL,
  document_id uuid,                         -- generated PDF
  published_at timestamptz,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, run_id, employee_id)
);
```

`calc_note` is not optional decoration. When a customer disputes a number, it is the difference between a five-minute answer and a day of forensics.

### 2.3 Immutability, enforced in the database

Service-layer checks are not sufficient — background jobs and consoles bypass them.

```sql
CREATE FUNCTION reject_locked_payroll_write() RETURNS trigger AS $$
DECLARE s payroll_run_status;
BEGIN
  SELECT status INTO s FROM payroll_runs
   WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
     AND id        = COALESCE(NEW.run_id,   OLD.run_id);
  IF s = 'locked' THEN
    RAISE EXCEPTION 'payroll run % is locked; create a revision instead',
      COALESCE(NEW.run_id, OLD.run_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_lines
  FOR EACH ROW EXECUTE FUNCTION reject_locked_payroll_write();
-- same trigger on payroll_inputs, payslips
```

`payroll_runs` itself gets a status-transition trigger: from `locked`, the only permitted UPDATE is none.

---

## 3. Corrections — revisions, not edits

HR finds an error in a locked September run:

```
payroll_runs
  #27  period 2026-09  revision 1  status=locked   net ₹41,20,000
  #31  period 2026-09  revision 2  status=locked   net ₹41,44,500
       supersedes_run_id = #27
       correction_reason = "Regularization approved late for 3 employees"
```

Revision 2 is a **full recomputation** with corrected inputs, not a patch. The delta is derived, not stored:

```sql
CREATE VIEW payroll_revision_delta AS
SELECT n.tenant_id, n.run_id AS new_run_id, o.run_id AS old_run_id,
       n.employee_id, n.component_code,
       o.amount_paise AS old_amount, n.amount_paise AS new_amount,
       n.amount_paise - COALESCE(o.amount_paise,0) AS delta_paise
FROM payroll_lines n
LEFT JOIN payroll_lines o
       ON (o.tenant_id, o.employee_id, o.component_code)
        = (n.tenant_id, n.employee_id, n.component_code)
      AND o.run_id = (SELECT supersedes_run_id FROM payroll_runs
                       WHERE tenant_id = n.tenant_id AND id = n.run_id);
```

If the bank file for revision 1 already went out, the delta is carried into the **next** period as an `ARREAR` adhoc input rather than reissuing payment. Whether to re-pay or carry forward is an HR decision presented at revision time; the system supports both and records which was chosen.

---

## 4. Calculation order and rounding

Fixed, and tested as a unit:

1. Resolve monthly gross components from `monthly_components`
2. Prorate for `joined_mid_period` / `exited_mid_period` (calendar-day basis, configurable to fixed-30)
3. Apply LOP: `lop_amount = round(monthly_gross × lop_days / calendar_days)`
4. Add OT, arrears, bonuses, reimbursements from `adhoc`
5. → **Gross**
6. PF: 12% of PF wage. PF wage = basic + DA, capped at the configured ceiling unless the employee is on uncapped election. Employer share split into EPF/EPS per config.
7. ESI: applies only if gross ≤ threshold. **Once an employee is in an ESI contribution period, they stay in it until the period ends even if gross crosses the threshold** — this is the single most commonly mis-implemented Indian payroll rule and has a dedicated golden test.
8. PT: slab lookup on `state_code` + gross
9. TDS: projected annual method under the elected regime, less declared/proofed investments, divided by remaining months
10. Other deductions: loans, advances, salary advance recovery
11. → **Net**

**Rounding:** every component rounds to the nearest rupee (`round(paise/100)*100`) at the moment it is written to `payroll_lines`. Gross and net are the **sums of rounded lines**, never a rounded sum — so the payslip always adds up visually.

---

## 5. Statutory configuration is data, not code

```sql
CREATE TABLE statutory_configs (           -- global, not tenant-scoped
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from date NOT NULL, effective_to date,
  pf_employee_rate numeric(5,4) NOT NULL,
  pf_employer_rate numeric(5,4) NOT NULL,
  pf_wage_ceiling_paise bigint NOT NULL,
  eps_rate numeric(5,4) NOT NULL, eps_ceiling_paise bigint NOT NULL,
  esi_employee_rate numeric(5,4) NOT NULL, esi_employer_rate numeric(5,4) NOT NULL,
  esi_gross_threshold_paise bigint NOT NULL,
  notes text
);

CREATE TABLE pt_slabs (                     -- global, per state
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code text NOT NULL,
  effective_from date NOT NULL, effective_to date,
  gross_from_paise bigint NOT NULL, gross_to_paise bigint,
  amount_paise bigint NOT NULL,
  month_override smallint          -- e.g. the February-only higher slab in some states
);

CREATE TABLE tax_slabs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regime text NOT NULL,             -- old | new
  fiscal_year text NOT NULL,        -- '2026-27'
  income_from_paise bigint NOT NULL, income_to_paise bigint,
  rate numeric(5,4) NOT NULL, surcharge_rules jsonb, cess_rate numeric(5,4) NOT NULL
);
```

These are **global reference data with their own effective dates**, snapshotted into `payroll_inputs.statutory_config_id` at freeze. When the budget changes a rate, you insert rows; you do not deploy code, and you do not retroactively change any locked run.

---

## 6. Validation gate

The run cannot advance from `calculated` to `validated` while any **blocker** exists.

| Blocker | Warning |
|---|---|
| Net pay < 0 | Net pay changed > 25% vs previous period |
| Missing bank account / IFSC | New joiner with no attendance rows |
| PF applicable but UAN missing | LOP > 15 days |
| ESI applicable but ESIC number missing | Employee on unpaid leave whole period |
| `lop_days > calendar_days` | Gross variance vs prior period > threshold |
| Compensation change effective inside the period with no approval | Employee exited but not marked FNF |
| Employee in run with no frozen input row | |

Warnings require explicit acknowledgement (recorded in `audit_events` with the acknowledging user), not silent passage.

---

## 7. Full & Final settlement

FNF is a payroll run with `fnf = true` on the input row, plus:

- leave encashment pulled from `leave_ledger` balance at exit date (writes an `encashment` entry)
- notice-period recovery or payment
- gratuity where eligible (≥ 5 years; `15/26 × last drawn basic+DA × completed years`)
- asset-recovery and advance-recovery deductions (V1: manual adhoc lines; the assets module later feeds these automatically)

FNF locks like any other run and produces its own payslip and bank line.

---

## 8. Bank file

```sql
CREATE TABLE bank_export_files (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  format text NOT NULL,          -- hdfc_csv | icici_csv | axis_csv | generic_neft
  object_key text NOT NULL, checksum_sha256 text NOT NULL,
  line_count int NOT NULL, total_paise bigint NOT NULL,
  generated_by_user_id uuid NOT NULL, generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```

Generation is only permitted from a `locked` run. The checksum and total are recorded so a customer's "the bank got a different file" claim is answerable. Bank formats are per-bank templates in config — expect to add one per customer for the first several customers, and budget for it.

---

## 9. Golden-file test suite (the payroll launch gate)

40 hand-computed scenarios, each an input fixture and an expected `payroll_lines` set. Minimum coverage:

- plain full-month salaried employee
- mid-month joiner; mid-month leaver; joiner and leaver in the same month
- LOP: 1 day, 15 days, full month
- half-day LOP
- PF at ceiling / above ceiling / uncapped election / employee exempt
- **ESI threshold crossed mid-contribution-period (stays in)**
- ESI applicable on joining mid-period
- PT slab boundary values, both sides, plus the month-override state
- both tax regimes, with and without declared investments
- arrears from a prior-period revision
- OT paid
- leave encashment in FNF; gratuity at exactly 5 years and at 4 years 11 months
- rounding: gross whose components each round up, asserting gross = sum of rounded lines

These run in CI on every commit. A red golden file blocks merge. This suite is the actual proof that PEPL can be sold as a payroll product.
