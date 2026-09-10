# PEPL — Screen contracts

This document specifies **what each screen does**: its data, states, permissions and empty/error behaviour. It deliberately does not specify visual design — layout, type, colour and motion are a separate pass done with the design skill against these contracts, once the API shapes in `api-boundaries.md` are settled.

> **Status: incomplete, and superseded for UI work by [CODEX-BRIEF.md](../../CODEX-BRIEF.md).**
> The brief is generated against the routes that exist; this document was written
> against the core HR + payroll scope and predates
> the configuration admin surface, helpdesk, tasks, incentives, activities, mail, chat, announcements,
> the company activity log and the control-plane console. Those screens are specified inside their own
> module documents; this file needs a rewrite to cover the full navigation. Treated as a known gap.

---

## Web — HR / admin operations surface

### W1. Dashboard
`GET /me`, plus three fixed aggregates. No configurable widgets at launch.

| Block | Content | Permission |
|---|---|---|
| Today | present / absent / on leave / late — counts, each linking to a filtered attendance grid | `attendance.read` |
| Payroll status | current period, run status, next action button (Freeze / Calculate / Review / Approve / Lock) | `payroll.read` |
| My approvals | count + top 5 from `/approvals/inbox` | `approval.act` |
| Headcount | active, joined this month, exited this month | `employee.read` |

The payroll block is the primary call to action for the whole product — it is the thing an HR user opens PEPL to do.

### W2. Employees — list
Cursor-paginated table; filters: department, location, status, manager, joining-date range. Column set fixed. Bulk actions: export CSV (audited), none destructive.
**Scope-aware:** a `manager` sees only their reports, with no indication of the total headcount.

### W3. Employee profile
Header: name, employee number, designation, department, manager, status.
Tabs, each a separate fetch:

| Tab | Source | Notes |
|---|---|---|
| Overview | `current_employee_profile` | tier-3 fields masked; reveal is per-field, audited |
| Employment | `employee_assignments` | shows **history as a list**, not a single current value; "Change" opens the effective-dated form |
| Compensation | `compensation_records` | requires `compensation.read`; each row shows effective date, who changed it, reason |
| Attendance | daily rows for a chosen month | |
| Leave | balances per type + request history + ledger drill-down | balance is a link to the ledger that explains it |
| Documents | `documents` | presigned downloads |
| Payslips | `payslips` | |
| Timeline | `/employees/{id}/timeline` | merged, reverse-chronological, across every history table + audit |

**The effective-dated change form** is the single most important interaction in the web app. It must ask for: what changed, **effective from when**, and why — and it must show a preview line reading *"Effective 1 Oct 2026: Senior Developer → Lead Developer. This does not affect payroll for September."* If users can change a field without supplying an effective date, the entire §3 schema is defeated at the UI layer.

Corrections are a distinct action ("This was recorded incorrectly") with different copy and a mandatory reason, because they mean something different from a change.

### W4. Org setup
Departments (tree), designations, grades, locations (with map pin + geofence radius), shifts, holiday calendar. CRUD, low frequency, low ceremony.

### W5. Import
Wizard: upload → sheet select → column mapping (with suggested mappings) → validate → preview → commit.
Preview shows `✓ 287 valid · ⚠ 11 warnings · ✕ 4 errors` with a per-row drill-down and a downloadable error CSV. Commit is disabled while any error exists; warnings require a checkbox. This screen is a sales asset — it is what a prospect is shown to prove migration is not a project.

### W6. Attendance grid
Employees × days for one period. Cells colour-coded by status, click to inspect punches (with map and selfie for `manager`/`hr_admin`, audited). Filters by department/location/status. Actions: mark regularization, close period.
Close is confirmation-gated and states plainly: *"Regularizations after close apply to the next period."*

### W7. Regularizations & leave requests
Both are lists feeding the approval inbox. Leave policy screen creates a **new policy version**; there is no edit-in-place, and the UI says so.

### W8. Approvals inbox
One list, all entity types, from `/approvals/inbox`. Columns: type, subject, requested, age. Actions: approve, reject, send back, comment, bulk-approve of same-type items. Each row expands to the entity's detail inline — the approver never navigates away and loses their queue.

### W9. Payroll
The run screen is a linear stepper mirroring `payroll.md` §1:

```
Inputs frozen → Calculated → Validation → Approved → Locked → Paid
```

- **Inputs**: per-employee frozen values (payable days, LOP, components), searchable, exportable. Read-only after freeze, with an explicit "Unfreeze" that is only available before calculation and is audited.
- **Validation**: blockers (red, block progress) and warnings (amber, require per-item acknowledgement with a note). Each links to the employee causing it.
- **Review**: register view — employee × component matrix, with a **variance column against the previous period** and a filter for "changed by more than X%". This is how HR actually catches errors.
- **Lock**: confirmation naming the total net, the employee count, and the irreversibility. Post-lock the screen shows Revise instead of Edit.
- **Revision view**: side-by-side old/new with the delta column, from `/payroll/runs/{id}/delta`.

### W10. Audit log
Filterable by actor, action, entity, date. Row expands to before/after with tier-3 masking. Read-only, exportable, `audit.read` only.

### W11. Settings
Company profile, statutory identifiers, payroll calendar, roles assignment, notification preferences, retention policy view.

---

## Mobile — employee action surface

Six core screens. Additional surfaces (helpdesk, tasks, chat, mail) are added deliberately, each earning its place — the mobile app must not become a shrunken web console.

### M1. Home
- Greeting, date, current shift
- **Punch In / Punch Out** — the single dominant action. States: ready, acquiring location, outside geofence (with distance and the office name), selfie capture, submitting, queued-offline, done.
- Today's status line: first in, last out, worked duration
- Up to four quick actions: Leave · Payslip · Attendance · Regularize
- Upcoming: next holiday, approved leave, pending requests

**Offline is a first-class state, not an error.** A punch taken without connectivity is queued locally with `client_punch_id`, shown as "will sync", and deduped server-side. Field staff lose signal constantly; a punch screen that fails when offline is a product that gets uninstalled.

**Geofence failure must be actionable**, never a dead end: show how far outside they are, and offer "request regularization" or "mark field duty" rather than a bare refusal.

### M2. Attendance
Month calendar, colour-coded; tap a day for punches and status; regularization request from the day view.

### M3. Leave
Balances per type (with an "how is this calculated" expansion reading from the ledger), apply form with a live *"this will leave you with N days"* preview and policy-violation messages stated before submission, not after. Request history with statuses.

### M4. Payslips
List by period, tap to view a rendered summary, download PDF. Never cached to device storage beyond the session.

### M5. Profile & documents
View identity, masked tier-3 fields, upload documents, view assignment and designation. Edits to identity fields route through an approval where the tenant requires it.

### M6. Approvals (managers only)
Same inbox as W8, reduced: type, who, what, when. Approve / reject / send back with a comment. Push-notified.

---

## Cross-cutting requirements

| Requirement | Rule |
|---|---|
| Empty states | Every list specifies its empty copy and its primary action. "No data" alone is not acceptable in any screen. |
| Permission-aware nav | Menu items absent, not disabled-and-teasing, when the permission is missing. Entitlement-gated modules likewise. |
| Tier-3 reveal | Always an explicit per-field action, always audited, never bulk. |
| Destructive actions | Payroll lock, period close, import commit, and correction each require typed or explicit confirmation naming the consequence. |
| Errors | Show the stable error code alongside human copy — support cannot triage "something went wrong". |
| Accessibility | Keyboard-operable web throughout; mobile punch reachable one-handed; contrast and target sizes verified in the design pass. |
| Latency | Attendance grid for 500 employees × 31 days must render under 2s; it is the heaviest routine query in the product and the one to design the index for. |
