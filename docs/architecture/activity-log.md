# PEPL — Company activity log

> **Requirement:** log everything that happens in a company's account on the platform — visible to that company, and to nobody else.

Two audiences with different needs, served by one event spine:

| Audience | Needs | Surface |
|---|---|---|
| **Tenant** (HR, admin, auditor) | "Who changed Rahul's salary?" · "Why did September payroll differ?" · "Who exported the employee list?" | Company activity log, per-record history, per-employee timeline |
| **Platform** (us) | Incident forensics · abuse detection · support · isolation assurance | Control-plane log, separate and never mixed |

---

## 1. One spine, module detail alongside

A single `audit_events` table that everything writes to, plus the module-specific append-only tables that already exist (`config_change_log`, `attendance_corrections`, `approval_actions`, `leave_ledger`, `ticket_events`, `payroll_lines`). The spine answers *what happened across the company*; the module tables answer *what exactly changed, in domain terms*.

Trying to make one table do both produces either a spine too coarse to explain a payroll delta, or a spine so detailed it cannot be browsed.

```sql
CREATE TABLE audit_events (
  tenant_id  uuid NOT NULL,
  id         bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- who
  actor_user_id uuid,
  actor_type text NOT NULL,        -- user | system | integration | support | anonymous
  actor_label text,                -- denormalised name+role at the time; survives deletion
  on_behalf_of_user_id uuid,       -- delegation / impersonation

  -- what
  action text NOT NULL,            -- 'compensation.changed'  (see §2)
  category text NOT NULL,          -- people|attendance|leave|payroll|config|security
                                   -- |comms|access|data|billing
  severity text NOT NULL DEFAULT 'info',   -- info | notice | warning | critical

  -- to what
  entity_type text NOT NULL, entity_id uuid,
  entity_label text,               -- 'EMP-00482 · Rahul Sharma' at the time
  subject_employee_id uuid,        -- whose record this concerns (drives visibility)

  -- detail
  before jsonb, after jsonb,       -- tier-3 masked before write (§5)
  metadata jsonb,                  -- counts, filters used, file names, amounts
  reason text,                     -- mandatory for high-risk actions

  -- context
  request_id uuid, session_id uuid,
  ip inet, user_agent text,
  source text NOT NULL,            -- web | mobile | api | job | import | support_console
  api_key_id uuid,

  -- integrity
  prev_hash bytea, row_hash bytea,  -- §7

  PRIMARY KEY (tenant_id, id)
) PARTITION BY RANGE (occurred_at);   -- monthly partitions
```

```sql
CREATE INDEX ON audit_events (tenant_id, occurred_at DESC);
CREATE INDEX ON audit_events (tenant_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX ON audit_events (tenant_id, actor_user_id, occurred_at DESC);
CREATE INDEX ON audit_events (tenant_id, subject_employee_id, occurred_at DESC);
CREATE INDEX ON audit_events (tenant_id, category, occurred_at DESC);
```

**Append-only, enforced by grant — not by convention:**

```sql
REVOKE UPDATE, DELETE ON audit_events FROM app_user;
```

The application role can `INSERT` and `SELECT`. It physically cannot rewrite history. Retention purges drop whole partitions under the control-plane role, which is a separate, audited operation.

---

## 2. Action taxonomy

`<module>.<entity>.<verb>`, past tense, closed vocabulary declared in code — not free-text strings scattered across route handlers.

```
people.employee.created | .updated | .status_changed | .exited | .deleted
people.assignment.changed | .corrected
people.compensation.changed | .corrected | .approved
people.document.uploaded | .downloaded | .deleted
people.custom_field.defined | .changed

attendance.punch.recorded | .corrected | .rejected
attendance.day.marked_half | .marked_wfh | .marked_absent | .marked_present
attendance.period.closed | .reopened
attendance.regularization.requested | .approved | .rejected

leave.request.applied | .approved | .rejected | .cancelled | .withdrawn
leave.policy.created | .versioned
leave.balance.adjusted | .lapsed | .carried_forward
leave.compoff.credited | .consumed | .expired

payroll.run.created | .inputs_frozen | .unfrozen | .calculated | .validated
                    | .warning_acknowledged | .approved | .locked | .revised
payroll.payslip.published | .viewed | .downloaded
payroll.bankfile.generated | .downloaded
payroll.statutory_override.applied

config.setting.changed | .reset | .scheduled
config.module.enabled | .disabled
config.role.created | .permissions_changed
config.approval_chain.changed

security.login.succeeded | .failed | .locked_out
security.mfa.enabled | .disabled | .challenged
security.session.revoked
security.password.changed | .reset
security.permission.denied

access.tier3.revealed        -- salary/bank/PAN unmasked  ← READ is logged
access.record.viewed         -- confidential tickets, HR cases
access.support.granted | .started | .ended | .revoked

data.export.requested | .completed        -- who exported what, how many rows
data.import.committed
data.erasure.requested | .completed
data.retention.purged

comms.announcement.published | .acknowledged
comms.mail.account_connected | .disconnected
billing.plan.changed | .invoice_issued | .payment_failed
```

Adding an action requires a registry entry with a label, category, severity, and whether a `reason` is mandatory — the same discipline as the config registry. A CI check fails the build if `audit(...)` is called with an action not in the registry.

---

## 3. Emission — where and how

**At the service boundary, inside the same transaction as the change.**

```ts
await db.tx(tenantId, async (t) => {
  const before = await repo.get(id)
  const after  = await repo.update(id, patch)
  await audit.emit(t, {
    action: 'people.compensation.changed',
    entity: { type: 'employee', id, label },
    before, after, reason: input.reason,
  })
})
```

Two rules that make this trustworthy:

1. **Same transaction.** The change and its audit row commit together or not at all. An audit written after commit can be lost on a crash; one written before can describe a change that rolled back. Either produces a log nobody can rely on.
2. **In the service, not the controller.** Background jobs, imports, scheduled accruals and any future AI caller pass through services — so they are logged identically. There is no path that mutates data without being logged, because there is no path that bypasses the service layer.

**CI gate:** every service method that writes to a tenant-owned table must emit an audit event. Enforced by a test that runs the integration suite with an audit-counting harness and fails on any mutation without a corresponding event.

**What is deliberately *not* logged:** password hashes, tokens, session cookies, mail credentials, mail bodies, full bank account numbers, chat message bodies (the fact of a message is logged for retention purposes; its content is not). Logging the wrong thing turns the audit log itself into the breach.

---

## 4. Read logging — the part usually skipped

Writes are the easy half. For a payroll product, **reads of sensitive data matter as much**, and are what makes a breach investigation answerable at all.

Logged reads:

- `access.tier3.revealed` — every unmasking of salary, CTC, bank account, PAN, UAN, with the record and the reason
- `payroll.payslip.viewed` / `.downloaded` — by someone other than the owner
- `data.export.completed` — every export, with row count, filters and file checksum
- `access.record.viewed` — confidential helpdesk categories (grievance, POSH), including by permitted committee members
- `access.support.*` — every platform-support session, visible in the *tenant's own* log

Ordinary reads (opening an employee profile, listing attendance) are **not** written to `audit_events` — the volume would bury the signal and the storage cost is real. They go to the observability pipeline with a 30-day retention, queryable during an incident, not part of the permanent record.

That line — permanent audit for sensitive reads, ephemeral telemetry for ordinary ones — is the one to hold. Logging everything equally makes the log useless.

---

## 5. Masking

`before`/`after` pass through a field classifier before insert:

| Field tier | In the log |
|---|---|
| Tier 1–2 (department, designation, dates, status) | Full values |
| Tier 3 (salary, bank, PAN, UAN, precise location) | Values **only when the action is a change to that field itself**; otherwise `{"changed": true}` |
| Never (passwords, tokens, secrets, mail bodies) | Omitted entirely |

Viewing a tier-3 value inside a log entry requires the same permission as viewing it on the record (`compensation.read`, `bank.read`) — and that view is itself logged. A log that leaks what the UI protects is a lateral path around the permission model.

---

## 6. Tenant-facing surfaces

The log is a product feature, not a database table HR is told exists.

**① Company activity log** — the main screen. Reverse-chronological, filterable by actor, category, severity, entity, employee, date range, source. Saved filters. Export to CSV/PDF for auditors.

**② Per-record history** — a History tab on every employee, payroll run, leave request and policy. "Who changed this, when, from what, why" without leaving the record.

**③ Employee timeline** — the merged narrative view:
```
12 Jan  Offer issued            HR · Priya
01 Feb  Joined
02 Feb  Laptop assigned         IT · Suresh
15 Apr  Probation confirmed     HR · Priya
01 Aug  Salary revised          ₹10,00,000 → ₹12,00,000   Payroll · Anil
        reason: annual revision · effective 01 Oct
05 Sep  Promoted                Senior Developer → Lead    HR · Priya
```

**④ Payroll run provenance** — on every locked run: every config change, correction, compensation change and override that landed in that period, and every action on the run itself. This is what answers *"why was September different?"* in five minutes instead of a day.

**⑤ Security log** — logins, failures, lockouts, MFA changes, permission denials, session revocations, support access. The screen a security-conscious buyer asks to see during evaluation.

**⑥ Digest** — a weekly email to org admins: high-severity actions, config changes, exports, support sessions. Most tenants will never open the log screen; the digest is what makes the log actually protective.

### Who sees what

| Role | Scope |
|---|---|
| `org_admin`, `auditor` | Everything in the tenant |
| `hr_admin` | Everything except confidential ticket access by others |
| `payroll_admin` | Payroll, compensation, billing |
| `manager` | Their reports only, and never compensation |
| `employee` | Their own record's history, and every access to their own tier-3 data — *including who looked at their salary* |

That last row is deliberate. An employee being able to see who accessed their bank details is both a DPDP-aligned transparency measure and a strong deterrent against casual snooping by colleagues with broad roles.

**Confidential helpdesk categories are excluded from every view** except the named committee's, per `helpdesk.md` §1.3 — the log must not become the back door around confidentiality.

---

## 7. Tamper evidence

For a payroll product, "the log says so" needs to survive a hostile question — including one about us.

Each event stores `prev_hash` (the previous event's `row_hash` for that tenant) and `row_hash = SHA256(prev_hash || canonical_json(event))`. A chain per tenant. Every day, a job seals the chain by writing the tip hash to a separate append-only table under the control-plane role.

```sql
CREATE TABLE control_plane.audit_seals (
  tenant_id uuid NOT NULL, sealed_date date NOT NULL,
  last_event_id bigint NOT NULL, tip_hash bytea NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sealed_date)
);
```

Any retrospective edit or deletion breaks the chain and is detectable by re-walking it. This is cheap (one hash per insert) and it converts the log from *"trust the operator"* to *"verify"*. A verification endpoint lets a tenant's auditor check their own chain.

---

## 8. Retention, volume and performance

- **Monthly partitions**, so retention drops partitions rather than mass-deleting the largest table in the system.
- **Default retention 8 years** for payroll, compensation, statutory and access categories (statutory basis); 2 years for low-severity operational events. Tenant-configurable **upward only** — a tenant may keep more, never less than the statutory floor.
- **Legal hold** suspends purging for a tenant, an employee or a date range. Without it, a routine purge destroys evidence during an active investigation.
- **Volume estimate:** ~500 employees ≈ 3–8k events/month ≈ 100 MB/year. Trivial. The volume risk is entirely in over-logging reads (§4) — which is why ordinary reads go to telemetry instead.
- Hot partitions on fast storage; partitions beyond 12 months moved to cheaper storage and queried on demand.

---

## 9. Alerting

Some events should not wait for someone to open a screen. Configurable per tenant, with sensible defaults on:

| Trigger | Default |
|---|---|
| Bulk export > 100 employee records | Notify org admins |
| Compensation changed for > 10 employees in a day | Notify org admins |
| A locked payroll run revised | Notify org admins + payroll |
| Statutory override applied | Notify org admins |
| Platform support session started | Notify org admins, banner while live |
| Repeated permission denials by one user | Notify org admins |
| Login from a new country / impossible travel | Notify the user and org admins |
| Module disabled, or approval chain changed | Notify org admins |
| Employee data erasure completed | Notify org admins |

---

## 10. The platform's own log

Separate table, separate schema, control-plane role, never mixed with tenant data: what *our* staff did — every support session, every entitlement change, every impersonation, every break-glass approval, every purge.

The parts of it that concern a tenant are **mirrored into that tenant's own log**, so a customer can see every time we touched their data without asking us. That mirroring is the difference between claiming isolation and demonstrating it.
