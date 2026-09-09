# PEPL — Platform architecture

A configurable, India-focused HR and employee-operations platform, launching publicly.
Every tenant administrator has full control over how PEPL behaves **for their own company**, and no control over any other company.

**Architecture first. Nothing is built until this set is agreed.**

> ### Design principle
> PEPL is built to the **standard company model** — the org structure, calendars, leave types, salary
> structure, approval hierarchy and statutory baseline that Indian firms actually share — and every one
> of those is a **default a tenant can change**, never a rule the product enforces.
> Start at **[standard-company-model.md](architecture/standard-company-model.md)**.

## Read in this order

| # | Document | What it settles |
|---|---|---|
| 1 | [architecture/standard-company-model.md](architecture/standard-company-model.md) | **The reference model: how companies organise and run workforce operations, and PEPL's defaults** |
| 2 | [architecture/overview.md](architecture/overview.md) | System shape, control vs application plane, stack, decisions of record, scaling, reliability |
| 3 | [architecture/configurability.md](architecture/configurability.md) | **The five configuration layers, the tenant control charter, registry, guardrails, testing** |
| 4 | [PRD.md](PRD.md) | Full launch scope, ICP, the monthly cycle, product launch gates |
| 5 | [architecture/data-model.md](architecture/data-model.md) | Schema: tenancy, bitemporal employee facts, attendance, leave ledger, approvals, audit, import |
| 6 | [architecture/payroll.md](architecture/payroll.md) | Input freeze, run revisions, immutability, calculation order, statutory data, golden files |
| 7 | [architecture/tenancy-security.md](architecture/tenancy-security.md) | RLS, per-transaction tenant context, isolation tests, risk tiers, retention, DPDP |
| 8 | [architecture/api-boundaries.md](architecture/api-boundaries.md) | Modules, dependency rules, permission model, REST surface, jobs, deferred seams |
| 9 | [architecture/leave-attendance-ops.md](architecture/leave-attendance-ops.md) | **Leave ledger · half-day · WFH · leave customisation · HR/manager overrides · approvals** |
| 10 | [architecture/payments.md](architecture/payments.md) | **Salary disbursement, bank files, payout APIs, reimbursements, loans, double-payment defence** |
| 11 | [architecture/activity-log.md](architecture/activity-log.md) | **Company activity log: everything that happens in a tenant, tamper-evident** |
| 12 | [architecture/screens.md](architecture/screens.md) | Web and mobile screen contracts |
| 13 | [architecture/field-sales-ops.md](architecture/field-sales-ops.md) | Tasks, activities, incentives — and why sales tracking is not CRM |
| 14 | [architecture/helpdesk.md](architecture/helpdesk.md) | Employee helpdesk and platform support desk, SLA, confidential categories, support access grants |
| 15 | [architecture/mail.md](architecture/mail.md) | **Mail: IMAP/SMTP client model, sync engine, credential custody, per-tenant config** |
| 16 | [architecture/communication.md](architecture/communication.md) | Chat and announcements (its §5 mailbox section is superseded by mail.md) |
| 17 | [architecture/platform-control-plane.md](architecture/platform-control-plane.md) | Public launch: signup, provisioning, plans, billing, support, trust, launch gates |

## The tenant control principle

```
capability (we built it)
  AND release flag (it is safe to run)
  AND entitlement (they bought it)
  AND tenant setting (they turned it on)          ← the customer's control
  AND scope override (for this dept/location)     ← the customer's control
```

Most restrictive wins, and a tenant setting can never widen an entitlement. Full detail, including what the customer can and cannot change and why, is in [configurability.md](architecture/configurability.md) §1 and §8.

## The seven decisions that are expensive to reverse

1. **Employment facts are bitemporal** — `effective_from/to` + `recorded_at/superseded_at`. Retrofitting history onto mutable columns is a rewrite.
2. **Payroll reads only frozen `payroll_inputs`**, never live attendance. Without this, no run is reproducible.
3. **A locked payroll run is immutable at the database level**; corrections are new revisions carrying a delta.
4. **Configuration is a fact about the company that changes over time** — payroll-affecting settings are effective-dated and snapshotted onto the run.
5. **Tenant context is set per transaction** (`SET LOCAL`), because PgBouncer transaction pooling does not preserve session state — every path, including jobs and exports, goes through one helper.
6. **Authorization is permission strings at the service boundary**, not roles in controllers — which makes custom roles, and any future AI caller, safe additions rather than rewrites.
7. **Money is `bigint` paise**, and rounding happens once, explicitly, per component.

## Scope map

**Decision: one public launch, after everything is complete.** No staged public releases. The waves are *build* order driven by dependencies, not shipping milestones.

| Wave | Work |
|---|---|
| **1** | Foundation: tenancy · RLS + `FORCE` + per-transaction context · CI isolation gate |
| **2** | Config layer: registry · entitlements · effective-dated settings · scoped overrides · change log |
| **3** | Core HR: employees (bitemporal) · org hierarchy · assignments · documents · import |
| **4** | Workforce: calendars · shifts · attendance capture · leave ledger · approvals |
| **5** | Payroll: structures · statutory · input freeze · revisions · immutability · disbursement |
| **6** | Work: tasks · onboarding/offboarding · helpdesk with SLA · incentives · expenses |
| **7** | Comms: mail client · chat · announcements · notifications |
| **8** | Control plane: signup · provisioning · plans · billing/GST · dunning · support desk |
| **9** | Mobile app · activity log surfaces · trust surface · [launch gates](architecture/platform-control-plane.md) · **launch** |



## Open decisions

| # | Question | Blocks |
|---|---|---|
| 1 | ~~Mailbox model?~~ **Resolved: per-user IMAP/SMTP client.** Companies keep their existing mail provider; no sending domain, no MX, no deliverability problem — [mail.md](architecture/mail.md) | Closed |
| 2 | Launch state for professional tax, and first bank file format | Nothing architectural; both are config/data. Needed from customer one |
| 3 | ~~Chat: build or buy?~~ **Decided: build on Postgres + Redis** | [communication.md](architecture/communication.md) §3, §9 |
| 4 | Default leave quotas and week pattern to seed new tenants | State-varying; defaults proposed in [standard-company-model.md](architecture/standard-company-model.md) §5 |
