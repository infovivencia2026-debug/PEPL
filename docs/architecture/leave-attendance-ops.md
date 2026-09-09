# PEPL — Leave, attendance and the override model

Covers leave balances, half/full day, remote work, leave customisation, manager/HR corrections, and approvals — built to the reference model in [standard-company-model.md](standard-company-model.md), with every policy configurable per tenant.

---

## 1. Leave balance — a ledger, not a counter

The common implementation stores a `leave_balances(used, pending)` counter per employee per type and mutates it on every approval. It is the wrong shape, and it fails in three predictable ways:

- **The annual rollover is an invisible mutation.** If the reset job fails, misfires, or is never written, balances silently carry stale values into the new year — and the symptom appears months later as leave requests being wrongly rejected.
- **A wrong balance is unexplainable.** A counter has no memory of how it reached its value, so support cannot answer "why is my balance 4.5?" without reconstructing history from requests.
- **Corrections corrupt it.** A cancelled leave, a retroactive policy change or a re-run accrual double-counts, because the counter has no idempotency key.

PEPL stores movements and derives the number.

```sql
CREATE TABLE leave_ledger (              -- append-only
  tenant_id uuid NOT NULL, id bigserial,
  employee_id uuid NOT NULL, leave_type_id uuid NOT NULL,
  entry_type text NOT NULL,   -- opening | accrual | consumption | reversal
                              -- | encashment | lapse | carry_forward | adjustment
  delta_days numeric(6,2) NOT NULL,
  effective_date date NOT NULL,
  cycle_year int NOT NULL,               -- the leave year this belongs to
  source_type text, source_id uuid,      -- leave_request | accrual_run | comp_off | import
  note text, created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```

```
balance(employee, type, as_of) = SUM(delta_days)
                                 WHERE effective_date <= as_of
                                   AND cycle_year = current_cycle
```

| Property | Consequence |
|---|---|
| Append-only | A wrong balance is always explainable — you can read the history that produced it |
| Accrual keyed `(employee, type, cycle, period)` | Re-running the job cannot double-credit |
| Year rollover writes `lapse` + `carry_forward` entries | The rollover is *visible* and auditable, not an invisible reset that can silently fail |
| Cancellation writes `reversal` | The original consumption is never deleted |
| `pending` is derived from open requests | Not a stored number that can drift out of sync |

**Balance surfaces show four numbers, not one:** opening, accrued to date, consumed, available — with a drill-down to the ledger entries. "Why is my balance 4.5?" must be answerable by the employee without a ticket.

---

## 2. Half day and full day

Companies use one of two accepted practices, and PEPL supports both as tenant configuration:

| Practice | Behaviour |
|---|---|
| **Explicit marking** (default) | A manager or HR marks the day as half. Nothing is inferred. |
| **Hours-derived** | Worked hours below `half_day_hours` auto-marks half; the threshold is configurable. |

**The default is explicit**, because an hours rule converts an unusual commute, a forgotten punch or a device failure into a pay cut, and every such day becomes a dispute. Companies that want automation can enable it knowingly.

```sql
-- on daily_attendance
day_fraction   numeric(3,2) NOT NULL DEFAULT 1.00,   -- 1.00 | 0.50 | 0.00
fraction_source text,        -- system | manager_marked | leave | regularization
marked_by_user_id uuid, marked_reason text
```

Leave itself is applied per day-part, so a request carries the shape rather than just a day count:

```json
day_parts: { "2026-09-14": "full", "2026-09-15": "first_half", "2026-09-16": "second_half" }
```

Payroll consumes `day_fraction`; it never re-derives it from hours. Rules that follow:

- Work on a weekly off or holiday is **overtime or a comp-off credit, never a half-day**. Systems that classify by hours alone get this wrong and dock people for coming in on a Sunday.
- A half-day worked remotely renders as **½**, with remote shown as a separate mark. Overloading one cell with both facts is why muster views become ambiguous.
- Tenant-configurable: `leave.min_unit` = `full_day | half_day | hourly`. Hourly leave stores minutes and converts at the tenant's `hours_per_day`.

---

## 3. Work from home

Remote work is **an attribute of a day, not a status** — a person can be remote *and* half-day, or remote *and* on a holiday. Encoding it as a status value forces a false choice and collides with the others (the classic symptom is one letter, `H`, meaning both Holiday and Home).

```sql
-- on daily_attendance
is_wfh boolean NOT NULL DEFAULT false,
wfh_source text,             -- requested | manager_marked | policy_default
wfh_request_id uuid
status text NOT NULL         -- present | absent | weekly_off | holiday | on_leave | od
```

An approved remote day **takes precedence over punch-derived presence** — the employee is working, wherever the geofence thinks they are — and it **must always be revocable**, because an irreversible mark is an unfixable payroll error.

Whether remote days are paid is a company policy, not a product rule. It is tenant configuration, effective-dated because it affects payroll:

| Setting | Default |
|---|---|
| `attendance.remote_enabled` | on |
| `attendance.remote_is_paid` | paid |
| `attendance.remote_requires_approval` | on |
| `attendance.remote_max_days_per_month` | unlimited |
| `attendance.remote_allowed_scopes` | all — scopable by department/grade/location |
| `attendance.remote_requires_punch` | on — a WFH day still needs a punch, without geofence |

Field duty (`od`) is a sibling attribute with the same shape: off-site, paid, geofence bypassed, flagged for review.

---

## 4. Customising leave

Fully tenant-owned. A company creates any leave type it wants, with a versioned policy.

```sql
leave_types      code · name · is_paid · affects_lop · color · icon
leave_policies   version · effective_from/to  (never edited in place)
    accrual_method            monthly | yearly | on_joining | per_worked_days | none
    accrual_units_per_period  1.5
    accrual_prorate_on_join   true
    cycle_start_month         4              -- fiscal or calendar leave year
    max_balance               30
    carry_forward_limit       15
    carry_forward_expiry_months 12
    encashable                true
    encashment_basis          basic | gross
    allow_negative_balance    false
    min_unit                  half_day
    probation_allowed         false
    sandwich_holidays         false          -- count intervening off-days
    notice_days               2
    max_consecutive_days      15
    backdating_limit_days     30
    requires_document_after_days 3           -- sick leave certificate
    gender_restriction        any | female | male    -- maternity/paternity
    min_tenure_months         0
    applies_to                {"department_ids":[],"grade_ids":[],"location_ids":[]}
```

**Policies are versioned, never edited.** Changing accrual creates version N+1 with an `effective_from`; employees on the old version stay there until the new one takes effect. Historical ledger entries never change — which is what makes a two-year-old balance defensible.

**Compensatory off** is a leave type with an earning rule attached:

```sql
comp_off_credits   work_date · expires_on · status(available|consumed|expired)
                   UNIQUE (tenant_id, employee_id, work_date)
```

Work on a weekly off or holiday mints a credit; the credit expires (30–90 days is typical); consuming one writes a `consumption` entry against the comp-off type. The uniqueness constraint prevents double-minting for one date. Whether credits are automatic or approval-gated is configurable.

> **A named golden-file scenario:** when payroll caps paid leave against a quota, the set of leave codes counted in the numerator must be **exactly** the set the cap is built from. If comp-off is counted as consumed but excluded from the cap, an earned comp-off day silently becomes LOP and underpays a day. This is an easy mistake and an expensive one, so it is a required test, not a review note.

---

## 5. Instant manager/HR corrections — the hardest part

The requirement — *HR can add, remove or edit leaves and punches instantly* — collides directly with *payroll must be reproducible and auditable*. Both are non-negotiable, so the resolution is not to restrict the edit but to **constrain how it is recorded and when it can land**.

### Three rules

**① Corrections are append-only. Nothing is ever overwritten.**

Raw punches are immutable. A correction is a new record that supersedes, exactly like a payroll revision.

```sql
CREATE TABLE attendance_corrections (
  tenant_id uuid NOT NULL, id bigserial,
  employee_id uuid NOT NULL, work_date date NOT NULL,
  action text NOT NULL,       -- set_punch_in | set_punch_out | add_day | mark_absent
                              -- | mark_half_day | mark_wfh | mark_od | mark_leave
                              -- | clear_leave | mark_present | revoke
  before jsonb NOT NULL, after jsonb NOT NULL,
  reason text NOT NULL,                       -- mandatory, always
  actor_user_id uuid NOT NULL,
  source text NOT NULL,       -- hr_console | manager_muster | regularization_approval
                              -- | bulk_import | system
  approval_request_id uuid,                   -- when the tenant requires approval
  applied_at timestamptz NOT NULL DEFAULT now(),
  reverted_by_id bigint,
  PRIMARY KEY (tenant_id, id)
);
```

`daily_attendance` is then a **derived projection** of raw punches plus corrections, recomputed idempotently. Nothing is lost; any day can be replayed to show what it looked like before someone touched it.

**② The period state decides what an edit can do.**

```
PERIOD OPEN            → applies immediately, recompute, done
                         (this is the "instant" case — the common one)

PERIOD CLOSED          → blocked by default.
(pre-freeze)             Permission `attendance.reopen_period` may reopen it,
                         which is audited and notifies payroll.

INPUTS FROZEN /        → NEVER edits the past period.
RUN LOCKED               The correction is recorded and routed to the NEXT
                         period as an arrear adjustment, with a link back.
```

This is the standard payroll cutoff discipline every finance team already applies to their books, enforced structurally rather than by convention. It is what stops a well-meaning HR edit on the 29th from silently changing a run that has already been approved and paid.

**③ Every correction re-triggers derived recomputation, in order.**

```
attendance_correction
     └─► recompute daily_attendance (that employee, that date)
          └─► reverse/re-apply leave_ledger entries if leave changed
               └─► recompute comp-off eligibility for the date
                    └─► if the period is open, mark payroll inputs stale
                         └─► emit audit_event + notify the employee
```

**The employee is always notified.** A correction the affected person cannot see is indistinguishable from an error — and the common implementation bug is an approval that updates the request row without actually fixing the attendance day, which looks to the employee like being ignored. Notification closes that loop and makes the bug impossible to ship silently.

### What HR and managers can actually do

| Action | Manager | HR | Notes |
|---|---|---|---|
| Set/fix punch in or out | own reports | all | Original punch retained |
| Add a missing day | own reports | all | For someone who never punched |
| Mark absent / present | own reports | all | |
| Mark half day | own reports | all | The only way a half-day happens |
| Mark / revoke WFH | own reports | all | Always revocable |
| Mark field duty | own reports | all | |
| Apply leave on behalf | own reports | all | Writes a normal ledger consumption |
| Cancel approved leave | ✗ | all | Writes a reversal, restores balance |
| Adjust leave balance | ✗ | all | Ledger `adjustment`, reason mandatory |
| Bulk correct (a day, a team) | ✗ | all | One correction row per employee, one approval |
| Reopen a closed period | ✗ | with permission | Audited, payroll notified |
| Edit a frozen/locked period | ✗ | ✗ | Not possible for anyone — arrear only |

**Bulk is a first-class case**, not a loop in the UI: "the biometric device was down on the 12th — mark all 140 present" is a real Tuesday. It produces 140 correction rows with one shared reason and one approval, and it is reversible as a batch.

### Configurable, per tenant

`attendance.correction_requires_approval` (default off for HR, on for managers) · `attendance.correction_window_days` (how far back, default 30) · `attendance.allow_period_reopen` · `attendance.regularization_limit_per_month` · `attendance.self_regularization_enabled` · `leave.hr_can_adjust_balance` · `leave.backdating_limit_days`.

---

## 6. Approvals

One generic mechanism; every module routes through it, so the **universal inbox is a single query**.

```sql
approval_requests   entity_type · entity_id · chain_code · current_step · status
approval_steps      step_no · approver_user_id | approver_role · status
approval_actions    append-only: approve | reject | send_back | comment | delegate
```

`entity_type` covers: leave · attendance correction · regularization · WFH · comp-off · overtime · compensation change · employee change · payroll run · incentive payout · expense · asset · ticket escalation · document.

### Chains — configured, not coded

The tenant composes a chain from a fixed step vocabulary, per module and per scope:

```
manager → hr                     (default for leave)
manager                          (default for WFH)
manager → dept_head → hr         (long leave, > 5 days)
hr_only                          (balance adjustment)
payroll → finance                (payroll run: processor ≠ approver)
```

Steps resolve to: `manager` (from the employee's current assignment), `dept_head`, `hr`, `finance`, `role:<name>`, `named_user`. **Conditional routing is limited to bounded predicates** — leave duration, amount, leave type, department — not an expression language. That deferral survives; a formula engine before observing twenty real tenants produces the wrong language.

### Behaviour

| Feature | Rule |
|---|---|
| **Send back** | Returns to the requester for edit without rejecting — the most-used action in practice, and often the one that gets left out |
| **Delegation** | Time-boxed, auto-activated by the delegator's own approved leave — the system knows they're away |
| **Escalation** | After N hours, notify → reassign → auto-approve (only if the tenant explicitly enables auto-approve) |
| **Auto-approve rules** | Optional per type: WFH under 2 days, leave inside balance, corrections by HR |
| **Skip-level** | If the approver *is* the requester, or has left, the chain advances to the next step rather than deadlocking |
| **Withdrawal** | The requester can withdraw while pending; after approval it becomes a cancellation, which reverses the ledger |
| **Idempotency** | Approving twice is a no-op, not a double-consumption |
| **Bulk approve** | Same-type items from one screen, one action row each |
| **Mobile** | Push-notified, approvable in two taps |

### The inbox

```
GET /inbox → kind: approval | task | ticket
```

One queue for a manager. Nine modules feeding eight screens is the usability failure that makes managers ignore the system and approve things over WhatsApp — which is the actual problem PEPL is being built to solve.

---

## 7. How it reaches payroll

```
punches ──┐
leave ────┼──► daily_attendance (derived, day_fraction, is_wfh, status)
corrections ┘          │
                       │  period CLOSED
                       ▼
              PAYROLL INPUT FREEZE
                payable_days · lop_days · paid_leave_days
                half_day_count · wfh_days · wfh_is_paid (as configured then)
                ot_minutes · comp_off_consumed
                       ▼
              payroll engine  →  validate  →  approve  →  LOCK
```

Payroll never reads punches, leave or corrections directly. It reads the frozen snapshot — which is what makes a locked run reproducible even after HR has corrected six months of attendance since.
