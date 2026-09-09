# PEPL — Sales, incentives, activities and tasks

**Scope:** all four are in the launch. This document places them in the architecture and says plainly which belong in an HRMS and which pull PEPL into a different product category.

---

## 1. Honest categorisation

| Ask | What it actually is | Belongs in PEPL? |
|---|---|---|
| **Incentive tracking** | Variable pay: commissions, targets, achievement, payout | **Yes — core.** It is a payroll input. An Indian HRMS that cannot pay a sales incentive cannot run payroll for a company with a sales team. |
| **Task tracking** | Assigned work items with owner, due date, status | **Yes — infrastructure.** Onboarding checklists, offboarding, asset return, document collection and HR cases are all tasks. Building one task primitive serves five future modules. |
| **Activity tracking** | Field-staff visit logging: check-in at a client site, meeting notes, distance travelled | **Yes, conditionally.** It is a natural extension of the GPS attendance already in V1, and it is what Indian field-workforce customers ask for. It is a *workforce* feature. |
| **Sales tracking** | Leads, accounts, opportunities, pipeline stages, forecasts | **No — this is CRM.** |

### The one to push back on

**Sales tracking is a different product.** Leads, deal stages, pipeline and forecasting put PEPL against Zoho CRM, Salesforce and HubSpot — a different buyer (VP Sales, not HR), a different sales motion, and a category where "the HRMS also has a CRM" loses to a real CRM every time.

What PEPL genuinely needs from sales data is **the achievement number that drives the incentive payout** — and that should be *imported or integrated*, not owned:

```
Their CRM / spreadsheet / ERP
        ↓  (CSV import, API, or manual entry)
   achievement figures per employee per period
        ↓
   PEPL incentive engine
        ↓
   payroll_inputs.adhoc
```

That gets the customer the outcome they actually want — the right incentive on the payslip — without PEPL pretending to be a CRM. If a customer insists on capturing sales inside PEPL, the `sales_records` table below is deliberately thin: a record of what was sold, by whom, when, for how much. Targets and achievement, not pipeline.

I would build it thin, and revisit only if several customers refuse to integrate.

---

## 2. Where these sit

```
                        PEPL
   ┌──────────┬─────────────┬──────────────┬──────────────┐
 People   Workforce      Payroll        Work            Platform
   │          │              │              │               │
Employees  Attendance    Structures    ▸ Tasks         Config
Assignment ▸ Activities  Statutory     ▸ Activities     Approvals
Compensation  Leave      Runs          ▸ Incentives     Audit
              Shifts     Payslips      ▸ Sales (thin)
                              ▲              │
                              └──────────────┘
                        incentive payout →
                        payroll_inputs.adhoc
```

All four are **entitlement-gated, tenant-configurable modules** under `configurability.md` — a tenant that does not sell anything turns the whole Work group off and never sees it.

---

## 3. Tasks — the primitive to build first

One task model serves onboarding, offboarding, asset recovery, document collection, HR cases and ad-hoc assignment. Building it once, generically, is why it is worth doing early even though "task tracking" sounds peripheral.

```sql
CREATE TABLE task_templates (          -- e.g. "Onboarding — Sales Executive"
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  name text NOT NULL, trigger_event text,     -- employee.hired | employee.exited | manual
  applies_to jsonb NOT NULL DEFAULT '{}',     -- {"department_ids":[],"designation_ids":[]}
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE task_template_items (
  tenant_id uuid NOT NULL, template_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  title text NOT NULL, description text,
  assignee_rule text NOT NULL,   -- manager | hr | it | finance | employee | named_user | role
  assignee_ref uuid,
  due_offset_days int NOT NULL DEFAULT 0,     -- relative to the trigger date
  sequence int NOT NULL,
  blocks_completion boolean NOT NULL DEFAULT false,
  requires_attachment boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE tasks (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  title text NOT NULL, description text,
  assignee_user_id uuid, assignee_role text,
  subject_employee_id uuid,                   -- who the task is *about*
  source_type text, source_id uuid,           -- onboarding|offboarding|case|manual
  template_item_id uuid,
  priority text NOT NULL DEFAULT 'normal',
  due_date date,
  status text NOT NULL DEFAULT 'open',        -- open|in_progress|blocked|done|cancelled
  completed_by_user_id uuid, completed_at timestamptz,
  attachment_document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ON tasks (tenant_id, assignee_user_id, status, due_date);

CREATE TABLE task_comments (
  tenant_id uuid NOT NULL, id bigserial, task_id uuid NOT NULL,
  author_user_id uuid NOT NULL, body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```

Tasks surface in the **same inbox as approvals** (`api-boundaries.md`, `/approvals/inbox` becomes `/inbox` with `kind: approval | task`). A manager should have one queue, not two.

Task templates fire from the domain events already defined: `employee.hired` instantiates the onboarding template matching the new hire's department and designation; `employee.exited` instantiates offboarding, including asset recovery. That is the whole onboarding module, obtained from the task primitive plus events.

---

## 4. Activity tracking (field workforce)

Extends the GPS attendance already in V1. Same capture stack, different intent: attendance answers *were you working*, activity answers *where did you go and what happened*.

```sql
CREATE TABLE activity_types (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  name text NOT NULL,                    -- Client Visit | Demo | Collection | Service Call
  requires_checkin boolean NOT NULL DEFAULT true,
  requires_selfie boolean NOT NULL DEFAULT false,
  requires_notes boolean NOT NULL DEFAULT true,
  custom_fields jsonb NOT NULL DEFAULT '[]',   -- reuses custom_field_definitions
  counts_toward_attendance boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE activities (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL, activity_type_id uuid NOT NULL,
  party_name text,                       -- client/outlet/site, free text in V1
  party_ref text,                        -- external CRM id if integrated
  planned_date date,
  checkin_at timestamptz, checkin_lat numeric(9,6), checkin_lng numeric(9,6),
  checkout_at timestamptz, checkout_lat numeric(9,6), checkout_lng numeric(9,6),
  duration_minutes int,
  outcome text, notes text,
  custom jsonb NOT NULL DEFAULT '{}',
  selfie_object_key text,
  distance_from_prev_km numeric(8,2),    -- feeds mileage reimbursement
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ON activities (tenant_id, employee_id, planned_date);
```

Three things this earns beyond a visit log:

1. **Field-duty attendance** — an activity check-in marks the day present for staff who never enter an office (`counts_toward_attendance`), closing a real gap in the attendance model for field roles.
2. **Mileage** — `distance_from_prev_km` accumulated over a day is the input to a mileage reimbursement, which flows to `payroll_inputs.adhoc` like any other.
3. **Beat/route plans** — planned vs. actual visits per day, which is what field-sales managers in India actually buy this for.

**Privacy:** continuous location is risk tier 3 under `tenancy-security.md` §4. Activity GPS follows the same retention (180 days for raw coordinates), and the tenant setting `activities.track_between_visits` defaults to **off** — PEPL records visit endpoints, not a continuous breadcrumb trail, unless the tenant deliberately turns it on and accepts the notice obligation.

---

## 5. Sales records (thin, optional)

Only what the incentive engine needs.

```sql
CREATE TABLE sales_records (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  period_id uuid NOT NULL,              -- the incentive period this falls in
  occurred_on date NOT NULL,
  product_code text, party_name text,
  quantity numeric(14,3), value_paise bigint NOT NULL,
  activity_id uuid,                     -- optional link to the visit that produced it
  source text NOT NULL,                 -- manual | import | api
  external_ref text,
  is_reversed boolean NOT NULL DEFAULT false,   -- returns/cancellations
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source, external_ref)      -- idempotent import
);
```

No leads. No opportunity stages. No forecasting. If a customer needs those, they need a CRM, and PEPL should integrate with it.

---

## 6. Incentives — the module that genuinely belongs

This is the one with real product value, because it terminates in payroll and nothing else the customer owns does that.

```sql
CREATE TABLE incentive_plans (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  name text NOT NULL, version int NOT NULL,
  frequency text NOT NULL,               -- monthly | quarterly | annual
  metric text NOT NULL,                  -- sales_value | units | collections | custom
  calc_type text NOT NULL,               -- slab | percent_of_metric | flat_on_target
                                         -- | per_unit | matrix
  config jsonb NOT NULL,                 -- slabs, rates, caps, floors, kickers
  proration_rule text NOT NULL DEFAULT 'by_payable_days',
  payout_lag_periods int NOT NULL DEFAULT 0,     -- pay in the month after close
  requires_approval boolean NOT NULL DEFAULT true,
  clawback_enabled boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL, effective_to date,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, name, version)
);

CREATE TABLE incentive_targets (         -- effective-dated, like compensation
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL, plan_id uuid NOT NULL,
  period_id uuid NOT NULL,
  target_value numeric(16,3) NOT NULL,
  weight numeric(5,2) NOT NULL DEFAULT 100,
  effective_from date NOT NULL, effective_to date,
  recorded_at timestamptz NOT NULL DEFAULT now(), superseded_at timestamptz,
  set_by_user_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE incentive_periods (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  label text NOT NULL, period_start date NOT NULL, period_end date NOT NULL,
  status text NOT NULL DEFAULT 'open',   -- open|closed|calculated|approved|paid
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE incentive_calculations (    -- frozen, like payroll_inputs
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL, employee_id uuid NOT NULL, plan_id uuid NOT NULL,
  target_value numeric(16,3) NOT NULL,
  achieved_value numeric(16,3) NOT NULL,
  achievement_pct numeric(7,3) NOT NULL,
  payable_days numeric(5,2), proration_factor numeric(6,4) NOT NULL DEFAULT 1,
  gross_incentive_paise bigint NOT NULL,
  adjustment_paise bigint NOT NULL DEFAULT 0,
  final_incentive_paise bigint NOT NULL,
  calc_trace jsonb NOT NULL,             -- which slab, which inputs, which rate
  status text NOT NULL DEFAULT 'calculated',
  approved_by_user_id uuid, approved_at timestamptz,
  payroll_run_id uuid,                   -- set when pushed to payroll
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, period_id, employee_id, plan_id)
);
```

### Pipeline — deliberately the same shape as payroll

```
sales_records / activities / manual entry
        ↓
   ACHIEVEMENT AGGREGATION (per employee, per period, per metric)
        ↓
   INCENTIVE PERIOD CLOSED          ← no late sales after this
        ↓
   CALCULATION  (plan slabs, proration, caps, floors)
        ↓
   REVIEW + APPROVAL                 ← sales head, then HR/finance
        ↓
   PUSH TO PAYROLL  → payroll_inputs.adhoc [{code:'INCENTIVE', amount, note}]
        ↓
   payslip line, taxed as salary
```

The seam already exists: `payroll_inputs.adhoc` was defined in `payroll.md` §2.1 precisely so that variable pay can arrive from anywhere without the payroll engine knowing what an incentive is.

**Rules that matter:**

- An incentive can only be pushed to a payroll run whose inputs are **not yet frozen**. After freeze it goes to the next period, as an arrear.
- Once pushed and the run is locked, the calculation row is immutable. A correction is a **new adjustment line in a later period**, never an edit — same discipline as payroll revisions.
- `calc_trace` records which slab applied and why. Sales incentive disputes are the second most common payroll dispute after LOP, and they are unanswerable without it.
- **Clawback** (a reversed sale after payout) writes a negative adjustment in the next open period, never a retroactive edit.
- Achievement aggregation is a **derived, re-runnable** job over `sales_records` — the same "raw data → derived → frozen" pattern as attendance → payroll.

### Tenant configurability

Per `configurability.md`, incentive plans are `tenant_editable` in full: the tenant defines metrics, slabs, rates, caps, proration and approval chains themselves. The slab structure is data (`config` JSONB validated against a schema per `calc_type`), not code — so a new commission structure is a form, not a release.

What is *not* a free-form formula language: `calc_type` is a fixed vocabulary. A tenant composes slabs and rates; they do not write expressions. Same reasoning as the deferred workflow engine — observe twenty real plans before inventing a language.

---

## 7. Where this lands in the build sequence

All of it ships in the single launch; the ordering below is dependency-driven, not a release plan.

| Wave | Add |
|---|---|
| 6 | **Tasks** + template instantiation on hire/exit → this *is* the onboarding/offboarding module |
| 6 | **Activities** — field duty, visit logging, mileage → attendance for field staff |
| 6 | **Incentives** — plans, targets, achievement import, calculation, push to payroll |
| 6 | Thin `sales_records` capture, for customers who will not integrate an existing system |

The dependency order is real: incentives need the period/freeze discipline the payroll module establishes (wave 5), and activities need the capture stack attendance establishes (wave 4). Building incentives first would mean building the freeze machinery twice.
