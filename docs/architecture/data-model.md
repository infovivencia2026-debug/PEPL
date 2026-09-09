# PEPL — Data model

Postgres 16. `btree_gist`, `pgcrypto`, `citext` required.

## Conventions (non-negotiable)

1. **Every tenant-owned table has `tenant_id uuid NOT NULL`**, and it is part of every unique constraint and every foreign key pair. FKs are composite (`(tenant_id, id)`) so a cross-tenant reference is impossible at the DB level, not merely improbable.
2. **Money is `bigint` in paise.** Never float. Rounding happens once, explicitly, at defined points in the payroll engine (`payroll.md` §4).
3. **Facts that change over a career are effective-dated, never overwritten.**
4. **Postgres enums** for closed sets (status); lookup tables for tenant-configurable sets (leave types, designations).
5. **No `ON DELETE CASCADE`** on anything an auditor might ask about. Employees, compensation, payroll and audit rows are never hard-deleted; they carry `status` / `superseded_at`.

---

## 1. Tenancy

```sql
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name    text NOT NULL,
  display_name  text NOT NULL,
  pan           text,
  tan           text,
  pf_estab_code text,
  esi_code      text,
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  fiscal_year_start_month smallint NOT NULL DEFAULT 4,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- projection of the control-plane subscription; app role has SELECT only
CREATE TABLE tenant_entitlements (
  tenant_id      uuid PRIMARY KEY REFERENCES tenants(id),
  plan           text  NOT NULL,
  employee_limit int   NOT NULL,
  modules        jsonb NOT NULL DEFAULT '{}',   -- {"payroll":true,"ats":false}
  valid_until    date  NOT NULL,
  status         text  NOT NULL DEFAULT 'active'
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  email         citext NOT NULL,
  password_hash text,
  employee_id   uuid,              -- null for HR staff with no employee record
  status        text NOT NULL DEFAULT 'active',
  last_login_at timestamptz,
  UNIQUE (tenant_id, email)
);

CREATE TABLE user_roles (
  tenant_id uuid NOT NULL,
  user_id   uuid NOT NULL,
  role      text NOT NULL,   -- org_admin|hr_admin|payroll_admin|finance|manager|employee
  PRIMARY KEY (tenant_id, user_id, role)
);
```

`users.email` is unique **per tenant**, not globally. A consultant serving two companies gets two user rows; cross-tenant identity is a post-launch problem and solving it now would compromise isolation.

---

## 2. Org structures

```sql
CREATE TABLE departments (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  name text NOT NULL, parent_id uuid, code text,
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code)
);

CREATE TABLE grades (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  name text NOT NULL, rank int,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE designations (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  title text NOT NULL, grade_id uuid,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE locations (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  name text NOT NULL,
  state_code text NOT NULL,        -- drives PT slab + holiday calendar
  address text,
  geo_lat numeric(9,6), geo_lng numeric(9,6), geofence_radius_m int,
  PRIMARY KEY (tenant_id, id)
);
```

`locations.state_code` is the single field that makes multi-state payroll a data change rather than a rewrite. It exists from the first migration even while the launch covers a limited set of states.

---

## 3. Employee: identity vs. history

Identity is corrected in place (a fixed date of birth is a correction, not a new fact about a new period). Employment facts are effective-dated.

```sql
CREATE TYPE employee_status AS ENUM
  ('pre_joining','probation','active','notice','exited');

CREATE TABLE employees (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid DEFAULT gen_random_uuid(),
  employee_number text NOT NULL,
  first_name text NOT NULL, last_name text,
  dob date, gender text,
  personal_email citext, phone text,
  date_of_joining date NOT NULL,
  date_of_exit    date,
  status          employee_status NOT NULL DEFAULT 'active',
  -- risk tier 3: encrypted at rest, masked by default in API responses
  pan_enc bytea, uan_enc bytea, esic_number_enc bytea, aadhaar_last4 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_number)
);
```

### 3.1 The effective-dated pattern

Every history table carries four columns:

| Column | Meaning |
|---|---|
| `effective_from` / `effective_to` | **valid time** — when the fact was true in the world (`effective_to` NULL = open-ended) |
| `recorded_at` | **transaction time** — when we learned it |
| `superseded_at` | when this row stopped being what we believe (NULL = current belief) |

Rules:

- **Rows are never UPDATEd except to set `superseded_at` (and `effective_to`).** A correction inserts a new row.
- A **change** (promotion effective 1 Oct) closes the prior row's `effective_to` and inserts a new row.
- A **correction** (wrong salary entered last month) sets `superseded_at` on the wrong row and inserts a replacement with the same `effective_from`.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE employee_assignments (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  department_id uuid, designation_id uuid, grade_id uuid,
  location_id uuid, manager_employee_id uuid,
  employment_type text NOT NULL,    -- full_time|part_time|contract|intern
  shift_id uuid,
  effective_from date NOT NULL,
  effective_to   date,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  superseded_at  timestamptz,
  changed_by_user_id uuid NOT NULL,
  change_reason text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- No two *believed* assignments may overlap in valid time for one employee.
ALTER TABLE employee_assignments ADD CONSTRAINT assignment_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =, employee_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL);
```

`compensation_records` is structurally identical:

```sql
CREATE TABLE compensation_records (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  structure_id uuid NOT NULL,             -- -> salary_structures
  annual_ctc_paise bigint NOT NULL,
  components jsonb NOT NULL,              -- resolved monthly amounts in paise
  pay_frequency text NOT NULL DEFAULT 'monthly',
  effective_from date NOT NULL, effective_to date,
  recorded_at timestamptz NOT NULL DEFAULT now(), superseded_at timestamptz,
  changed_by_user_id uuid NOT NULL, change_reason text,
  approved_by_user_id uuid, approved_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);

ALTER TABLE compensation_records ADD CONSTRAINT compensation_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =, employee_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL);
```

The same pattern also governs `employee_bank_accounts`, `employee_policy_assignments` (which leave policy applies from when) and `employee_statutory_profiles` (PF opt-out, ESI applicability, tax regime election).

### 3.2 The query layer

Application code must never hand-write the four-predicate join. Two accessors only.

```sql
-- Current belief, as of today.
CREATE VIEW current_employee_profile AS
SELECT e.tenant_id, e.id AS employee_id, e.employee_number,
       e.first_name, e.last_name, e.status, e.date_of_joining,
       a.department_id, a.designation_id, a.location_id,
       a.manager_employee_id, a.employment_type, a.shift_id,
       c.annual_ctc_paise, c.structure_id
FROM employees e
LEFT JOIN employee_assignments a
       ON (a.tenant_id, a.employee_id) = (e.tenant_id, e.id)
      AND a.superseded_at IS NULL
      AND daterange(a.effective_from, a.effective_to, '[)') @> CURRENT_DATE
LEFT JOIN compensation_records c
       ON (c.tenant_id, c.employee_id) = (e.tenant_id, e.id)
      AND c.superseded_at IS NULL
      AND daterange(c.effective_from, c.effective_to, '[)') @> CURRENT_DATE;
```

```sql
-- Full bitemporal accessor. Payroll reprocessing and audits use this.
CREATE FUNCTION employee_profile_at(
  p_tenant     uuid,
  p_employee   uuid,
  as_of_valid  date,
  as_known_at  timestamptz DEFAULT now()
) RETURNS TABLE (...) ...;
-- predicate on every history table:
--       effective_from <= as_of_valid
--   AND (effective_to  IS NULL OR effective_to  >  as_of_valid)
--   AND recorded_at    <= as_known_at
--   AND (superseded_at IS NULL OR superseded_at >  as_known_at)
```

> "Who was Rahul's manager on 14 Aug 2026?" → `employee_profile_at(t, rahul, '2026-08-14')`
>
> "What did we *believe* his salary was when we ran August payroll?" → `employee_profile_at(t, rahul, '2026-08-31', run.locked_at)`

The second query is how a payroll revision proves exactly what changed and why — it is the reason for the transaction-time columns, and it is not obtainable from valid-time alone.

---

## 4. Attendance

Raw capture is append-only and never edited. Everything downstream is derived and recomputable.

```sql
CREATE TABLE attendance_punches (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  punched_at timestamptz NOT NULL,
  local_date date NOT NULL,          -- resolved in tenant tz at write time
  direction text NOT NULL,           -- in | out
  source text NOT NULL,              -- mobile | web | biometric_import | manual
  geo_lat numeric(9,6), geo_lng numeric(9,6), accuracy_m int,
  geofence_location_id uuid, within_geofence boolean,
  selfie_object_key text,
  device_id text, ip inet,
  client_punch_id text,              -- idempotency key for the offline queue
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_id, client_punch_id)
);

CREATE TABLE daily_attendance (      -- derived; recompute is idempotent
  tenant_id uuid NOT NULL, employee_id uuid NOT NULL, work_date date NOT NULL,
  shift_id uuid,
  first_in timestamptz, last_out timestamptz,
  worked_minutes int NOT NULL DEFAULT 0,
  break_minutes  int NOT NULL DEFAULT 0,
  ot_minutes     int NOT NULL DEFAULT 0,
  late_minutes   int NOT NULL DEFAULT 0,
  early_exit_minutes int NOT NULL DEFAULT 0,
  status text NOT NULL,   -- present|absent|half_day|weekly_off|holiday|on_leave|wfh|od
  leave_request_id uuid,
  is_regularized boolean NOT NULL DEFAULT false,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id, work_date)
);

CREATE TABLE attendance_periods (    -- the close gate
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  period_start date NOT NULL, period_end date NOT NULL,
  status text NOT NULL DEFAULT 'open',   -- open | closed
  closed_by_user_id uuid, closed_at timestamptz,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, period_start)
);

CREATE TABLE shifts (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  name text NOT NULL, start_time time NOT NULL, end_time time NOT NULL,
  crosses_midnight boolean NOT NULL DEFAULT false,
  grace_in_minutes int NOT NULL DEFAULT 0, grace_out_minutes int NOT NULL DEFAULT 0,
  half_day_threshold_minutes int, full_day_threshold_minutes int,
  break_minutes int NOT NULL DEFAULT 0,
  weekly_offs smallint[] NOT NULL DEFAULT '{7}',   -- ISO day-of-week
  ot_enabled boolean NOT NULL DEFAULT false, ot_after_minutes int,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE holidays (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  holiday_date date NOT NULL, name text NOT NULL,
  location_id uuid,                     -- null = all locations
  is_optional boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE attendance_regularizations (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL, work_date date NOT NULL,
  requested_in timestamptz, requested_out timestamptz,
  requested_status text, reason text NOT NULL,
  approval_request_id uuid,
  status text NOT NULL DEFAULT 'pending',
  PRIMARY KEY (tenant_id, id)
);
```

**A regularization for a closed period is rejected** and must be filed against the next period as an arrear adjustment. This is the rule that stops payroll drifting silently after a lock.

---

## 5. Leave

Balances are **derived from an append-only ledger**, never stored as a mutable number. A wrong balance is then always explainable, and re-running accrual is safe.

```sql
CREATE TABLE leave_types (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  code text NOT NULL, name text NOT NULL,
  is_paid boolean NOT NULL DEFAULT true,
  affects_lop boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code)
);

CREATE TABLE leave_policies (        -- versioned; never edited in place
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  leave_type_id uuid NOT NULL, version int NOT NULL,
  accrual_method text NOT NULL,      -- monthly | yearly | on_joining | none
  accrual_units_per_period numeric(6,2) NOT NULL DEFAULT 0,
  accrual_prorate_on_join boolean NOT NULL DEFAULT true,
  max_balance numeric(6,2),
  carry_forward_limit numeric(6,2) NOT NULL DEFAULT 0,
  encashable boolean NOT NULL DEFAULT false,
  allow_negative_balance boolean NOT NULL DEFAULT false,
  min_unit text NOT NULL DEFAULT 'half_day',   -- full_day | half_day | hourly
  probation_allowed boolean NOT NULL DEFAULT false,
  sandwich_holidays boolean NOT NULL DEFAULT false,  -- count intervening off-days
  notice_days int NOT NULL DEFAULT 0,
  max_consecutive_days int,
  applies_to jsonb NOT NULL DEFAULT '{}',  -- {"location_ids":[],"grade_ids":[],"employment_types":[]}
  effective_from date NOT NULL, effective_to date,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, leave_type_id, version)
);

CREATE TABLE leave_requests (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL, leave_type_id uuid NOT NULL,
  start_date date NOT NULL, end_date date NOT NULL,
  day_parts jsonb NOT NULL,     -- {"2026-09-14":"full","2026-09-15":"first_half"}
  total_days numeric(5,2) NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|cancelled|withdrawn
  approval_request_id uuid,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE leave_ledger (          -- append-only. balance = SUM(delta_days)
  tenant_id uuid NOT NULL, id bigserial,
  employee_id uuid NOT NULL, leave_type_id uuid NOT NULL,
  entry_type text NOT NULL,          -- accrual|opening|consumption|reversal
                                     -- |encashment|lapse|adjustment
  delta_days numeric(6,2) NOT NULL,
  effective_date date NOT NULL,
  source_type text, source_id uuid,  -- leave_request | accrual_run | import
  note text, created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ON leave_ledger (tenant_id, employee_id, leave_type_id, effective_date);
```

Cancelling an approved leave writes a `reversal`; it never deletes the `consumption`. The accrual job is keyed on `(employee, leave_type, period)` so a re-run cannot double-credit.

---

## 6. Approvals — generic mechanism, fixed chains

```sql
CREATE TABLE approval_requests (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,   -- leave|regularization|compensation|payroll_run|employee_change
  entity_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  subject_employee_id uuid,
  chain_code text NOT NULL,    -- 'manager' | 'manager_then_hr' | 'hr_only'  (fixed set in V1)
  current_step int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|sent_back|cancelled
  created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE approval_steps (
  tenant_id uuid NOT NULL, approval_request_id uuid NOT NULL, step_no int NOT NULL,
  approver_user_id uuid, approver_role text,
  status text NOT NULL DEFAULT 'pending',
  PRIMARY KEY (tenant_id, approval_request_id, step_no)
);

CREATE TABLE approval_actions (      -- append-only
  tenant_id uuid NOT NULL, id bigserial,
  approval_request_id uuid NOT NULL, step_no int NOT NULL,
  actor_user_id uuid NOT NULL,
  action text NOT NULL,              -- approve|reject|send_back|comment|delegate
  comment text, acted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```

`chain_code` resolves against a three-entry table in code. When the workflow builder eventually arrives it becomes an FK to `workflow_definitions` and nothing else in the schema moves. That is the entire cost of deferring it — which is why deferring it is correct.

The **universal approval inbox** is one query over `approval_requests` — it is nearly free once every module routes through this table, and it is the reason to build the table generically from the start, even before chains are tenant-configurable.

---

## 7. Audit

```sql
CREATE TABLE audit_events (
  tenant_id uuid NOT NULL, id bigserial,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid, actor_type text NOT NULL,  -- user | system | integration
  action text NOT NULL,          -- compensation.changed, payroll_run.locked, ...
  entity_type text NOT NULL, entity_id uuid,
  before jsonb, after jsonb,     -- risk-tier-3 fields masked before write
  reason text,
  request_id uuid, ip inet, user_agent text,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ON audit_events (tenant_id, entity_type, entity_id, occurred_at DESC);

REVOKE UPDATE, DELETE ON audit_events FROM app_user;  -- append-only, enforced by grant
```

**Masking rule:** `before`/`after` pass through a field classifier before insert. Tier-3 fields (bank account, PAN, Aadhaar, salary) are written as values only when the action is itself a change to that field; everything else records `{"changed": true}`. Password hashes, tokens and full account numbers are never written.

---

## 8. Documents

```sql
CREATE TABLE documents (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  employee_id uuid, category text NOT NULL,  -- id_proof|payslip|contract|certificate
  file_name text NOT NULL, object_key text NOT NULL,
  mime_type text, size_bytes bigint, checksum_sha256 text,
  risk_tier smallint NOT NULL DEFAULT 2,
  uploaded_by_user_id uuid, uploaded_at timestamptz NOT NULL DEFAULT now(),
  retention_until date,
  PRIMARY KEY (tenant_id, id)
);
```

Object keys are prefixed `t/{tenant_id}/e/{employee_id}/…`. Every download is a short-lived presigned URL issued only after a permission check — never a public bucket path, never a guessable key.

---

## 9. Import

```sql
CREATE TABLE import_jobs (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  kind text NOT NULL,   -- employees|opening_leave_balances|past_attendance|compensation
  source_object_key text NOT NULL, sheet_name text,
  column_mapping jsonb NOT NULL,
  status text NOT NULL DEFAULT 'uploaded',  -- uploaded|validated|committed|failed
  row_count int, valid_count int, warning_count int, error_count int,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE import_rows (
  tenant_id uuid NOT NULL, import_job_id uuid NOT NULL, row_no int NOT NULL,
  raw jsonb NOT NULL, normalized jsonb,
  severity text,          -- ok | warning | error
  messages jsonb,
  created_entity_id uuid,
  PRIMARY KEY (tenant_id, import_job_id, row_no)
);
```

Commit is **all-or-nothing in one transaction**. The preview the user approves is rendered from `import_rows.normalized` — the exact values that will be written, not a second parse of the file.

---

## 10. Salary structures

Referenced by `compensation_records.structure_id` and snapshotted into `payroll_inputs`.

```sql
CREATE TABLE salary_structures (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  name text NOT NULL, version int NOT NULL,
  effective_from date NOT NULL, effective_to date,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, name, version)
);

CREATE TABLE salary_components (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  structure_id uuid NOT NULL,
  code text NOT NULL,                 -- BASIC, HRA, SPECIAL, CONVEYANCE, ...
  name text NOT NULL,
  component_type text NOT NULL,       -- earning|deduction|employer_contribution
  calc_type text NOT NULL,            -- flat | percent_of_ctc | percent_of_basic | balancing
  calc_value numeric(9,4),
  sequence int NOT NULL,              -- evaluation order; 'balancing' must be last
  taxable boolean NOT NULL DEFAULT true,
  pf_wage boolean NOT NULL DEFAULT false,   -- counts toward PF wage
  esi_wage boolean NOT NULL DEFAULT true,
  prorated_on_lop boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, structure_id, code)
);
```

Structures are **versioned, never edited in place** — an existing employee stays on the version they were assigned until an explicit compensation change moves them. `calc_type = 'balancing'` (typically SPECIAL ALLOWANCE) absorbs the rounding remainder so components always sum exactly to CTC; exactly one component per structure may be balancing, enforced by a partial unique index.
