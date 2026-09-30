# PEPL — Tenant isolation, security and privacy

A cross-tenant leak in PEPL is a payroll and bank-details breach. This is treated as the highest-severity class of defect in the product, above any feature.

> **Read [as-built.md](as-built.md) alongside this.** The isolation model below is built and gated, but
> the role names (`app_user`, `pepl_migrator`), password hashing (argon2id), refresh-token rotation,
> presigned URLs and tier-3 column encryption described here are the *design*; the running system uses
> `pepl_owner`/`pepl_app`, scrypt, opaque revocable sessions, API-streamed downloads and masking.

---

## 1. Roles in Postgres

Three database roles, and the application never uses the first two at runtime.

| Role | Use | RLS |
|---|---|---|
| `pepl_owner` | migrations only, CI/CD deploy step | owns tables; **`FORCE ROW LEVEL SECURITY` applies to it too** |
| `pepl_migrator` | schema changes | — |
| `app_user` | every runtime connection: API, workers, jobs, exports | `NOBYPASSRLS`, non-owner |

A table owner bypasses its own RLS policies unless `FORCE ROW LEVEL SECURITY` is set, and `BYPASSRLS`/superuser roles bypass policies regardless — so `app_user` is deliberately neither owner nor privileged, and `FORCE` is applied anyway as a second line.

```sql
ALTER TABLE employees ENABLE  ROW LEVEL SECURITY;
ALTER TABLE employees FORCE   ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON employees
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`WITH CHECK` is as important as `USING`: without it, a tenant can *write* a row belonging to another tenant even though it cannot read one back.

`current_setting(..., true)` returns NULL when unset, and `NULL = uuid` is NULL, which fails the policy — so a **missing tenant context yields zero rows rather than all rows**. That default must never be inverted.

---

## 2. Where the tenant context is set

```
request → authenticate → resolve tenant from the session (never from a header,
                          query param, or request body)
        → BEGIN
        → SET LOCAL app.tenant_id = '<uuid>'
        → SET LOCAL app.user_id   = '<uuid>'
        → authorized service call
        → COMMIT
```

**`SET LOCAL`, inside the transaction, every time.** Not `SET`. PgBouncer in transaction-pooling mode does not preserve ordinary session-level `SET` state between transactions, so any design that sets tenant context once per connection is broken under the pooler we intend to run — and broken in the worst possible way: intermittently, under load, serving another tenant's rows.

Concretely, this means:

- The DB session helper takes a tenant id and **cannot be called without one**. There is no default, no "system" fallback.
- Every code path opens its own transaction: HTTP requests, BullMQ workers, cron accrual jobs, report generation, CSV/bank-file export, payslip PDF generation, webhook handlers, and any future AI tool call.
- Genuinely cross-tenant work (platform-admin metrics) runs as a separate, explicitly named role with its own audit trail — never by unsetting `app.tenant_id`.

---

## 3. Mandatory tests

### 3.1 Cross-tenant behavioural suite

Per tenant-owned module, with tenants A and B populated:

| Acting as A, targeting B's data | Expected |
|---|---|
| `GET /employees/{B_id}` | 404 (not 403 — do not confirm existence) |
| `GET /employees?search=<B name>` | zero results |
| `PATCH /employees/{B_id}` | 404 |
| `POST /leave-requests {employee_id: B}` | 422 / 404 |
| employee CSV export | A's rows only, asserted by count and by id set |
| payroll run listing | A's runs only |
| document presigned URL for B's object key | denied |
| any report / aggregate | totals match A-only fixtures exactly |

### 3.2 CI structural gates

Run on every commit; failure blocks merge.

1. **Every table in the tenant-owned allowlist has `tenant_id NOT NULL`.**
2. **Every such table has `relrowsecurity` AND `relforcerowsecurity` true, and at least one policy with both `USING` and `WITH CHECK`.**
   ```sql
   SELECT c.relname FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relname NOT IN (SELECT table_name FROM _global_tables_allowlist)
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
   -- must return zero rows
   ```
3. **A new table appearing in neither the tenant-owned nor the global allowlist fails the build.** Adding a table is therefore a deliberate isolation decision, not an oversight.
4. **`app_user` has no `BYPASSRLS`, owns no tables, and holds no `UPDATE`/`DELETE` on `audit_events`.**
5. **Fuzz test:** run the full integration suite with `app.tenant_id` deliberately unset; every query must return zero rows or raise. No test may pass.

---

## 4. Data risk tiers

DPDP 2023 does not define a separate statutory "sensitive personal data" category, so classification is ours to define and enforce. Three tiers, applied to columns:

| Tier | Examples | Controls |
|---|---|---|
| 1 | department names, designations, holiday calendar | standard RLS |
| 2 | name, contact, DOB, attendance records, leave records | RLS + permission check + audit on write |
| 3 | compensation, bank account, PAN/UAN/ESIC, precise location traces, selfies, medical/disability records | RLS + explicit permission (`compensation.read`, `bank.read`) + **column encryption at rest** + masked by default in every API response + audit on **read as well as write** |

Tier-3 defaults:
- API returns `"****3421"` unless the caller holds the specific permission *and* passes `?reveal=true`, which emits an `audit_event`.
- Never logged, never in error messages, never in `audit_events.before/after` except for changes to the field itself.
- Encryption uses envelope encryption with per-tenant data keys; keys live in the secrets manager, never in the database or environment files.

**Location and selfie data** are tier 3 deliberately. Attendance selfies and GPS traces are the highest-volume tier-3 data PEPL will hold, they are collected continuously, and they have a defined retention (below) rather than living forever.

---

## 5. Retention

```sql
CREATE TABLE retention_policies (
  entity_type text PRIMARY KEY,
  retain_days int NOT NULL,
  basis text NOT NULL           -- statutory | operational | consent
);
```

| Data | Default retention | Basis |
|---|---|---|
| Attendance selfies | 90 days, then purge the object, keep the punch | operational |
| Raw GPS coordinates | 180 days, then keep only `within_geofence` | operational |
| Payroll runs, payslips, statutory registers | 8 years | statutory |
| Audit events | 8 years | statutory |
| Employee record after exit | 8 years, then anonymize identity, retain payroll aggregates | statutory |
| Documents | per-category, from `documents.retention_until` | mixed |

The purge job is a scheduled worker that runs per tenant with tenant context set (§2) and writes an `audit_event` per purge batch. Retention is built in V1 not because the deadline demands it, but because bolting purge onto a schema that assumed permanence is a migration project.

---

## 6. Privacy operations (V1 minimum)

- **Notice** at employee account activation, versioned; acceptance recorded with version and timestamp.
- **Access request:** one HR-triggerable export producing everything PEPL holds on one employee, in JSON + PDF.
- **Correction:** already native — every fact is effective-dated and correctable via `superseded_at`, and the correction is itself auditable. This is a genuine benefit of the §3 schema, not a coincidence.
- **Erasure:** anonymization, not deletion, for anyone with payroll history — statutory retention overrides. The API states this explicitly rather than failing silently.
- **Breach response:** the audit log must be able to answer "which records did user X access between these timestamps", which is why tier-3 **reads** are audited.

---

## 7. Application-layer security baseline

| Control | V1 |
|---|---|
| Password hashing | argon2id |
| Session | short-lived access token + rotating refresh; refresh reuse revokes the family |
| MFA | TOTP, optional per user, enforceable per tenant for `org_admin` / `payroll_admin` |
| Rate limiting | per IP and per user on auth, export, and punch endpoints |
| Object storage | private bucket, presigned URLs ≤ 5 min, permission-checked at issue |
| Transport | TLS only, HSTS |
| Secrets | secrets manager; no credentials in env files committed anywhere |
| Backups | daily + PITR; **restore rehearsed and documented before launch** |
| Mobile | certificate pinning, no tier-3 data cached on device beyond the current session |

An untested backup is not a backup. The restore rehearsal is a launch gate in `../PRD.md` §5, not a post-launch task.
