# PEPL — System architecture

The architecture of record. Read this before any other document; the rest are depth on individual subsystems.

---

## 1. Shape

Two planes, one codebase, one database cluster.

```
┌──────────────────────────── CONTROL PLANE ────────────────────────────┐
│  Public site · signup · tenant provisioning · plans & entitlements    │
│  billing · platform admin · support console · release flags · status  │
│  (its own DB schema, its own role, cross-tenant by design)            │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ writes entitlements, provisions tenants
                                ▼
┌──────────────────────────── APPLICATION PLANE ────────────────────────┐
│  Web app (Next.js)          Mobile app (Flutter)                      │
│            └────────────┬────────────┘                                │
│                    API (NestJS, modular monolith)                     │
│      ┌──────────────────┴──────────────────┐                          │
│  CONFIG RESOLVER                      AUTHZ (permissions)             │
│      └──────────────────┬──────────────────┘                          │
│   identity · tenancy · org · people · attendance · leave ·            │
│   approvals · tasks · payroll · documents · notifications · audit     │
│                         │                                             │
│                  platform/db  (tenant-scoped transactions ONLY)       │
└─────────────────────────┬─────────────────────────────────────────────┘
                          ▼
        PostgreSQL (RLS-enforced)  ·  Redis  ·  S3-compatible object store
```

**Why two planes.** Control-plane work is inherently cross-tenant (list all customers, meter usage, provision a new company). Application-plane work must never be. Mixing them means the isolation rule has exceptions, and an exception is the thing that eventually leaks. Separate roles, separate schemas, separate audit trails.

---

## 2. Decisions of record

| # | Decision | Rationale | Cost of reversing |
|---|---|---|---|
| 1 | **Modular monolith**, not microservices | One transaction across employee + payroll + audit is worth more than independent deploys at this scale. Boundaries are enforced in code, so extraction stays possible. | Low — module seams are already the service interfaces |
| 2 | **Shared Postgres + `tenant_id` + RLS with `FORCE`** | Correct to several thousand tenants. Dedicated DBs for enterprise later without an API change. | Medium |
| 3 | **Bitemporal employment facts** | Payroll must reproduce what was believed at lock time | **Very high** — decide now |
| 4 | **Payroll reads only frozen inputs** | Reproducibility and audit | **Very high** |
| 5 | **Five-layer configuration** (`configurability.md`) | The tenant-control requirement, made safe | High |
| 6 | **Permission strings at the service boundary** | Custom roles and any future AI caller inherit authorization for free | Medium |
| 7 | **Money as `bigint` paise** | Rounding is explicit and testable | High |
| 8 | **Append-only ledgers** (leave, audit, config, approvals) | Every number is explainable | High |

Decisions 3, 4 and 7 are the ones that cannot be retrofitted. Everything else can change under load.

---

## 3. Stack

| Layer | Choice | Note |
|---|---|---|
| Web | Next.js (App Router), TypeScript, React Query, Tailwind | HR operations surface; server components for the heavy grids |
| Mobile | Flutter | One codebase, reliable background location and offline queue — both are hard requirements for field attendance |
| API | NestJS on Node 22, TypeScript | Module system maps 1:1 to the domain modules; DI makes the tenant-scoped transaction helper injectable and therefore unavoidable |
| DB | PostgreSQL 16 | RLS, `btree_gist` exclusion constraints for effective-dating, JSONB for config and custom fields |
| Migrations | Drizzle or node-pg-migrate, forward-only | RLS policies and grants are migrations, not manual steps |
| Cache | Redis | Config resolution, sessions, rate limits, job queue |
| Queue | BullMQ | Attendance recompute, accrual, payslip generation, imports, notifications |
| Storage | S3-compatible, private, presigned reads | Documents, payslips, selfies, imports |
| PDF | Headless Chromium in a worker | Payslips and letters from HTML templates the tenant can edit |
| Search | Postgres FTS + trigram | OpenSearch only if employee search actually becomes slow |
| Auth | Own the identity layer; OIDC provider interface reserved for enterprise SSO | |
| Email / SMS / WhatsApp | SES or SendGrid · MSG91 · WhatsApp Cloud API | India: WhatsApp matters more than email for employee reach |
| Payments | Razorpay (primary), Stripe (international later) | Control plane only |
| Observability | OpenTelemetry → managed backend; structured logs with `tenant_id` + `request_id` | |
| IaC | Terraform | Environments reproducible; provisioning automated from day one |

**Deliberately not chosen yet:** Kafka, microservices, a service mesh, an OpenSearch cluster, and a third-party feature-flag vendor. Config is our own domain model (`configurability.md`), not a flag SaaS — flag vendors do not model entitlements, effective dates or per-scope overrides, and PEPL needs all three. An OpenFeature-shaped interface is used for the *release-flag* layer only, so a provider can be swapped in later without touching call sites.

---

## 4. The request path

Every request, without exception:

```
1  TLS termination, WAF, rate limit
2  Authenticate  → session → user_id, tenant_id
3  Load entitlements + resolved config  (cache hit: ~0 ms)
4  Build AuthzContext: permissions, data scope, report ids
5  BEGIN;  SET LOCAL app.tenant_id;  SET LOCAL app.user_id
6  Controller → service  (permission + scope asserted here, not in the controller)
7  Repository → Postgres, RLS enforced independently
8  Emit domain events + audit events in the same transaction
9  COMMIT
10 Async handlers pick up events from the queue
```

Steps 5–7 are three independent isolation checks: application scope, RLS policy, and composite foreign keys. A leak requires all three to fail together.

Background jobs enter at step 5 with an explicit tenant id and run the identical stack. There is no privileged path — which is what makes a future AI copilot safe by construction rather than by review.

---

## 5. Scaling path

Sized for the ICP (30–500 employees, hundreds of tenants), with the next two steps identified so they are not surprises.

| Concern | Now | Next |
|---|---|---|
| API | 2+ stateless instances behind a load balancer | Horizontal; it is already stateless |
| DB | One primary + one read replica | Replica for reports and exports; then partition `attendance_punches`, `daily_attendance`, `audit_events` by month |
| Pooling | PgBouncer, **transaction mode** | Non-negotiable interaction with `SET LOCAL` — see `tenancy-security.md` §2 |
| Payroll runs | Queue-isolated worker pool | Payroll must never contend with web traffic; a 5,000-employee run is CPU-bound |
| Noisy tenants | Per-tenant rate limits from `tenant_entitlements.limits` | Per-tenant job concurrency caps |
| Large tenants | Shared DB | Dedicated database, same code path, `tenant → connection string` map |
| Files | S3 + CDN for static | Lifecycle rules implement retention (`tenancy-security.md` §5) |

The heaviest routine query in the product is the attendance grid (employees × days). It is the one to index and benchmark deliberately: `daily_attendance (tenant_id, work_date, employee_id)` covering the displayed columns.

---

## 6. Environments and release

```
local  →  ci  →  staging (anonymised production-shaped data)  →  production
```

- **Forward-only migrations**, backward-compatible for one release: expand → deploy → migrate → contract. A payroll table is never altered in a way that breaks a running run.
- **Release flags** gate every non-trivial change, so deploying is not releasing — and a payroll defect is a flag flip, not a rollback.
- **Never deploy schema changes to payroll tables during a customer's payroll window.** A deployment calendar aware of tenants' pay dates is an operational requirement, not a nicety.
- CI gates, all blocking: unit, integration, **cross-tenant isolation suite**, **RLS structural check**, **payroll golden files**, **config registry invariants**, typecheck, lint, migration dry-run.

---

## 7. Reliability

| Concern | Commitment |
|---|---|
| Backups | Continuous archiving + PITR; **restore rehearsed before launch and quarterly after** |
| RPO / RTO | RPO ≤ 5 min, RTO ≤ 4 h |
| Per-tenant restore | Documented procedure to restore one tenant into a scratch schema and re-import — the realistic disaster, not total loss |
| Idempotency | Every job and every mutating endpoint; payroll and imports are strictly exactly-once by construction |
| Degradation | If Redis is down, config resolves from Postgres — slower, not broken. Config has no single point of failure. |
| Status page | Public, from day one of the public launch |

---

## 8. Observability

Every log line and span carries `tenant_id`, `user_id`, `request_id`. Non-negotiable dashboards:

- Payroll run duration and failure rate, **per tenant**
- Punch success rate by source, and offline-queue depth (the leading indicator of mobile trouble)
- Config resolution cache hit rate
- Job queue depth and age by queue
- Authorization denials by permission (a spike means a role or config change went wrong)
- Cross-tenant isolation alarm: **any query executed with `app.tenant_id` unset is a page**, not a log line

---

## 9. Document map

| Document | Subject |
|---|---|
| [PRD.md](../PRD.md) | Scope, ICP, the monthly cycle, launch gates |
| [configurability.md](configurability.md) | The five configuration layers, tenant control charter, registry, guardrails |
| [data-model.md](data-model.md) | Schema: tenancy, bitemporal employee facts, attendance, leave ledger, approvals, audit |
| [payroll.md](payroll.md) | Freeze, revisions, immutability, calculation order, statutory data, golden files |
| [tenancy-security.md](tenancy-security.md) | RLS, tenant context, isolation tests, risk tiers, retention, DPDP |
| [api-boundaries.md](api-boundaries.md) | Modules, dependency rules, permissions, REST surface, jobs |
| [platform-control-plane.md](platform-control-plane.md) | Public launch: signup, provisioning, plans, billing, support, trust |
| [field-sales-ops.md](field-sales-ops.md) | Tasks, activities, incentives, and why sales tracking is not CRM |
| [screens.md](screens.md) | Web and mobile screen contracts |
