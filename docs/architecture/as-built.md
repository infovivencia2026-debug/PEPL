# As designed, and as built

The other documents in this folder are the **design of record**: they say what PEPL is meant to be.
Several were written before the code and name components that were never adopted. This page is the
place where the two are reconciled, so nobody relies on a control that is not there.

Where this page and another document disagree, **this page describes the running system**.
It was written after the 2026-09-30 audit (`AUDIT-2026-09-30.md`, finding TST-03), and each row below
was checked against the source, not against the design.

## Controls that are described differently in the design

| Design says | What is built | Where to look |
|---|---|---|
| Passwords hashed with **argon2id** | **scrypt** with a random 16-byte salt per password | `src/auth/index.ts` |
| Short-lived access token plus **rotating refresh token**; reuse revokes the family | One **opaque server-side session token** (random, stored only as a hash), with an expiry, revocable per session or per user, and a `mfa_pending` flag until the second factor is proved. There is no refresh token | `sessions`, `auth_session_by_hash` (106 makes it require an active user) |
| Roles `pepl_migrator` and `app_user` | `pepl_owner` (migrations and DDL only), `pepl_app` (every runtime query; `NOBYPASSRLS`, owns nothing), and a control connection for the control plane. `postgres` bootstraps | `CLAUDE.md`, "Three database roles" |
| **Redis** for cache, sessions and rate limits; **BullMQ** for jobs; Redis pub/sub for realtime | None of them. Configuration resolves per request from Postgres with a version check. Rate limits are in process (`src/http/rate-limit.ts`) and in `rate_limit_buckets`. Jobs run in a separate **scheduler process** (`src/jobs/scheduler.ts`). Realtime is an in-process bus relayed through Postgres `LISTEN/NOTIFY` (`src/realtime/relay.ts`) | `src/jobs`, `src/realtime` |
| Documents served by **presigned URLs of at most five minutes** | The API checks permission and **streams the bytes itself** (base64 in the JSON response). Storage is Postgres by default, or an S3-compatible bucket if configured (hand-rolled SigV4); either way the read goes through the API. There are no presigned URLs | `src/http/routes/documents.ts`, `src/documents/object-store.ts` |
| **Tier-3 column encryption**, and `?reveal=true` on every sensitive field | No column encryption. Sensitive identifiers are **masked in responses**, and `?reveal=true` exists only where it was built (bank accounts, filings), each emitting an audit event. Mailbox passwords are encrypted with `PEPL_MAIL_KEY` | `src/http/routes/people.ts`, `filings.ts`, `src/comms/index.ts` |
| Payment gateway (Razorpay / Stripe), dunning through the gateway | **No gateway.** PEPL is sold by salespeople and paid by bank transfer. Invoices are raised and payments recorded through `npm run ops`; a nightly dunning job suspends and reactivates on that record | `docs/SELLING.md`, `src/control-plane/billing.ts` |
| The restore rehearsal is a launch gate in `../V1-PRD.md` | The PRD is [`../PRD.md`](../PRD.md). A restore has been drilled against a real production dump; see `CLAUDE.md`, "Backups are root-only" | `deploy/`, `CLAUDE.md` |

## Isolation, as it is actually enforced

The isolation model in `tenancy-security.md` is built and is the part most heavily tested: every
tenant table has `ENABLE` and `FORCE ROW LEVEL SECURITY` with both `USING` and `WITH CHECK`, the
tenant is set per transaction (`SET LOCAL`), and `npm run gate:rls` fails the build on a table or
policy that does not conform. Since the audit that gate reads each policy clause by its boolean
structure (`src/db/policy-lint.ts`) rather than searching for a substring, and it also refuses
non-`security_invoker` views and unclassified schemas.

Not stated in the design and now part of it:

- **Global tables are read-only to the runtime role** unless listed, with a reason, in
  `RUNTIME_WRITABLE_GLOBAL_TABLES` (`src/db/table-classification.ts`). `gate:launch` checks it.
- **Evidence tables are append-only** for the runtime role (`APPEND_ONLY_TABLES`), and a few are
  never hard-deleted (`NO_DELETE_TABLES`).
- **Within-tenant confidentiality lives in the policy**, not the service: a ticket, and now its
  messages and events, are invisible to anyone who may not see the ticket.

## Promised but not present

The PRD and the design promise the following. The audit found no such suite; none is claimed here.

- 40 **golden-file payroll scenarios** blocking merge (payroll is covered by `test/payroll.test.ts`,
  `exit.test.ts`, `arrears.test.ts`, `revision-payment.test.ts` and others, but not as a golden set).
- A **100-tenant provisioning** run, a **500-row import/export** run, and an **offline punch
  de-duplication** suite. Offline punches are not supported: a punch is recorded at the time the
  server receives it (see `src/attendance/punch-window.ts`).
- An **HTTP-level cross-tenant suite** for every route. `test/isolation.test.ts` exercises the
  database layer; most routes are covered only through their domain functions or `npm run smoke`.

## Statutory figures

Every statutory rate, slab and exemption in `db/reference/` is **reference data to be reconciled
with the current notification by a chartered accountant before anyone is paid on it**. That has not
been done. Nothing in the code should be read as a statement that a figure is current.
