# PEPL — Modules, API boundaries and authorization

Modular monolith. One deployable, one database, hard module boundaries enforced in code review and by a dependency lint rule.

---

## 1. Module map

```
apps/api
  modules/
    identity/      auth, users, sessions, MFA, OAuth
    tenancy/       tenants, entitlements, tenant context
    config/        registry, resolver, overrides, change log
    org/           legal entities, departments, grades, designations, locations,
                   shifts, calendars, holidays
    people/        employees, assignments, compensation, custom fields, import
    attendance/    capture, daily computation, periods, corrections, regularization
    leave/         types, policies, requests, ledger, accrual, rollover
    approvals/     requests, steps, actions, the unified inbox
    tasks/         templates, instances, onboarding/offboarding
    payroll/       structures, statutory, inputs freeze, engine, runs, payslips
    payments/      batches, instructions, bank files, payout adapters, reconciliation
    incentives/    plans, targets, achievement, calculation
    helpdesk/      categories, tickets, SLA, escalation, knowledge base
    comms/         mail client, chat, announcements, notifications
    documents/     templates, letters, storage, retention
    audit/         event write + query, activity log surfaces
  platform/
    db/            tenant-scoped transaction helper  (the ONLY way to reach Postgres)
    authz/         permission evaluation
    storage/       S3 presigning
    jobs/          BullMQ queues and schedulers
```

### Dependency rules (lint-enforced)

- A module may import another module's **public service interface only** — `modules/x/index.ts`. Never its repositories, never its tables.
- **No module reads another module's tables directly.** `payroll` does not `SELECT` from `daily_attendance`; it calls `attendance.getPeriodSummary()`. This is the rule that makes later extraction of a service possible and, more immediately, keeps the payroll freeze honest.
- `platform/db` is the only place that opens a transaction, and it requires a tenant id (see `tenancy-security.md` §2).
- Cycles are forbidden. Cross-cutting reactions go through the domain-event bus, not back-imports.

### Domain events (in-process)

```
employee.hired            → onboarding tasks, leave opening balance, user invite
employee.exited           → FNF payroll input, leave encashment, access revocation
compensation.changed      → audit, payroll variance warning next run
leave.approved            → daily_attendance recompute for those dates
attendance.period.closed  → payroll freeze becomes available
payroll.run.locked        → payslip generation, bank file availability, notifications
```

A synchronous in-process emitter with a handler registry. The handler signature is async and idempotent from the start, so moving to a queue later changes the emitter, not the handlers.

---

## 2. Authorization

Evaluated on **permission strings**, never role names, at the service-method boundary — not in controllers, so background jobs and any future AI tool call go through the same gate.

```ts
type Permission =
  | 'employee.read' | 'employee.write' | 'employee.read.self'
  | 'compensation.read' | 'compensation.write'
  | 'bank.read' | 'bank.export'
  | 'attendance.read' | 'attendance.write' | 'attendance.approve'
  | 'leave.read' | 'leave.apply' | 'leave.approve' | 'leave.policy.write'
  | 'payroll.read' | 'payroll.process' | 'payroll.approve' | 'payroll.lock'
  | 'document.read' | 'document.write'
  | 'approval.act' | 'audit.read' | 'import.run' | 'settings.write';

interface AuthzContext {
  tenantId: string;
  userId: string;
  employeeId?: string;
  permissions: Set<Permission>;
  scope: 'all' | 'reports' | 'self';   // data scope, evaluated separately
  reportIds?: string[];                // resolved manager chain, cached per request
}
```

Two independent checks on every call — **verb** and **scope**:

```ts
assertPermission(ctx, 'leave.approve');            // may they do it at all?
assertScope(ctx, targetEmployeeId);                // to this person?
```

Role → permission mapping starts as a static table in code (`authz/roles.ts`) and becomes a tenant-scoped `roles`/`role_permissions` pair when custom roles land in wave 2 — with no call-site changes. That is the whole reason for permission strings rather than role checks.

**Separation of duty, enforced:** `payroll.approve` and `payroll.lock` cannot be exercised by the user who ran `payroll.process` for the same run. This is a real audit finding in HRMS deployments and costs one check to prevent.

---

## 3. API surface

REST, `/api/v1`, JSON. Tenant is **always** from the session, never from the path or a header.

```
POST   /auth/login | /auth/refresh | /auth/logout | /auth/mfa/verify

GET    /me                                     profile + permissions + entitlements
GET    /employees                              filter, paginate, scope-aware
POST   /employees
GET    /employees/{id}
PATCH  /employees/{id}                         identity fields only
GET    /employees/{id}/timeline                merged history across all history tables
POST   /employees/{id}/assignments             effective-dated change  {effective_from, ...}
POST   /employees/{id}/compensation            effective-dated change  (requires approval)
POST   /employees/{id}/corrections             supersede a history row {record_id, reason, ...}
GET    /employees/{id}/profile-at?date=&known_at=

POST   /imports                                upload → returns mapping suggestion
POST   /imports/{id}/validate
GET    /imports/{id}/preview
POST   /imports/{id}/commit                    all-or-nothing

POST   /attendance/punch                       {direction, geo, selfie_key, client_punch_id}
GET    /attendance/daily?from=&to=&employee_id=
GET    /attendance/grid?period_id=             HR month view
POST   /attendance/regularizations
POST   /attendance/periods/{id}/close

GET    /leave/balances?employee_id=            computed from the ledger
POST   /leave/requests
POST   /leave/requests/{id}/cancel
GET    /leave/policies  |  POST /leave/policies        (new version, never an edit)

GET    /approvals/inbox                        THE universal inbox — one query
POST   /approvals/{id}/act                     {action, comment}

GET    /payroll/periods
POST   /payroll/runs                           {period_id}
POST   /payroll/runs/{id}/freeze-inputs
GET    /payroll/runs/{id}/inputs
POST   /payroll/runs/{id}/calculate
GET    /payroll/runs/{id}/validation           blockers + warnings
POST   /payroll/runs/{id}/acknowledge-warning  {code, note}
POST   /payroll/runs/{id}/approve
POST   /payroll/runs/{id}/lock
POST   /payroll/runs/{id}/revise               {reason} → new revision, unlocked
GET    /payroll/runs/{id}/delta                vs the run it supersedes
GET    /payroll/runs/{id}/bank-file
GET    /payslips?employee_id=&period=
GET    /payslips/{id}/pdf                      presigned

GET    /audit?entity_type=&entity_id=
```

### Conventions

- **Idempotency:** `Idempotency-Key` header required on punch, import commit, payroll freeze/calculate/lock, and bank-file generation.
- **Not-found over forbidden:** a resource in another tenant, or outside the caller's scope, returns 404. Never confirm existence.
- **Errors** carry a stable machine code: `{ "code": "PAYROLL_RUN_LOCKED", "message": ..., "details": {...} }`.
- **Pagination** is cursor-based everywhere; offset pagination on a 5,000-employee attendance grid is a support ticket waiting to happen.
- **Every mutating endpoint** takes an optional `reason` that lands in `audit_events.reason`, and it is **required** for compensation changes, corrections, and payroll revisions.

---

## 4. Jobs

| Job | Cadence | Notes |
|---|---|---|
| `attendance.recompute` | on punch, on leave approval, nightly sweep | idempotent per `(employee, date)` |
| `biometric.import` | nightly per configured device/SFTP | writes punches with `source='biometric_import'` |
| `leave.accrual` | monthly, per tenant | keyed on `(employee, leave_type, period)`; re-run cannot double-credit |
| `leave.lapse_carryforward` | at fiscal year end | writes `lapse` ledger entries |
| `payslip.generate` | on `payroll.run.locked` | one PDF per employee, then publish |
| `retention.purge` | daily | per `retention_policies`, audited |
| `notification.dispatch` | continuous | email + push |

Every job body opens its own tenant-scoped transaction. A job that iterates tenants opens one transaction per tenant — never one spanning several.

---

## 5. Seams for later-wave modules

Everything below ships before launch, but is built in a later wave. These seams exist so an early wave does not have to know about a later one:

| Module | Seam established early | Cost when it lands |
|---|---|---|
| Workflow builder | `approval_requests.chain_code` | becomes an FK to `workflow_definitions`; no other schema change |
| Custom roles | permission strings + `authz/roles.ts` table | move the table into the DB; no call site changes |
| Multi-entity | `tenant_id` is the isolation boundary; `legal_entity_id` is a nullable column added to employees/payroll | payroll grouping key changes; isolation does not |
| Multi-state payroll | `locations.state_code` + `pt_slabs` keyed by state | add slab rows; engine already reads them |
| Expenses / assets | domain events on hire/exit already emitted | new module subscribes |
| AI copilot | every service method is permission-gated and callable without HTTP | the copilot becomes a caller of existing services with the user's `AuthzContext` — **never a SQL generator, never a privileged path** |
| Billing engine | `tenant_entitlements` JSONB checked in one middleware | replace the row with a real subscription model |

The AI row is the important one. Because authorization lives at the service boundary and not in controllers, the copilot cannot be given a shortcut later even by accident — there is no method that skips the check, and `platform/db` cannot be reached without a tenant context.
