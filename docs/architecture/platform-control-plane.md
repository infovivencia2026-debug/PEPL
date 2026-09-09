# PEPL — Control plane and public launch

Everything that is *about* customers rather than *inside* a customer. Separate schema, separate database role, cross-tenant by design — which is exactly why it must not share a boundary with the application plane.

---

## 1. Separation

```
control_plane schema                   public schema (application)
──────────────────────                 ────────────────────────────
tenants_registry                       employees, payroll, attendance …
plans, subscriptions, invoices         tenant_settings, overrides
platform_users (our staff)             users (customer staff)
platform_tickets                       tickets
release_flags                          (read-only view of entitlements)
usage_counters
support_access_grants
signup_requests

role: control_user                     role: app_user
  no access to public.*                  SELECT-only on entitlements
                                         no access to control_plane.*
```

`app_user` **reads** entitlements and **never writes** them. A bug in the application can therefore never grant a tenant a module they have not bought — the write path does not exist in that role.

---

## 2. Self-service signup and provisioning

The public launch requirement. Median SaaS trial is ~2 weeks and most vendors do not ask for a card up front; PEPL should follow that, because the buyer needs to import employees and see a payslip before they will pay.

```
Landing page
   ↓  email + company name + employee-count band
Email verification                       (blocks throwaway domains, rate-limited)
   ↓
PROVISIONING  (single orchestrated, idempotent, resumable job)
   1  create tenant row + control-plane subscription (trial, 14 days)
   2  seed entitlements from the trial plan
   3  create org admin user + first login token
   4  seed defaults: leave types, shifts, holiday calendar for the chosen state,
      salary structure template, ticket categories, approval chains, roles
   5  create object-storage prefix
   6  register the tenant in the config cache
   7  emit tenant.provisioned  → welcome email, CRM, analytics
   ↓
GUIDED SETUP  (5 steps, tracked, resumable)
   company profile → locations → import employees → attendance rules → invite HR
   ↓
ACTIVATION  = first payroll preview generated
```

**Provisioning is one orchestrator, not seven callers.** Each step is idempotent and the job is resumable, because half-provisioned tenants are the most common early-SaaS support load. A failure at step 4 must not leave a tenant that can log in but has no leave types.

```sql
CREATE TABLE control_plane.provisioning_jobs (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  status text NOT NULL,                    -- pending|running|failed|completed
  completed_steps text[] NOT NULL DEFAULT '{}',
  last_error text, attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
```

**Activation, not signup, is the metric.** A tenant that signed up and imported nothing is not a customer. The guided-setup checklist is 5 steps because 3–5 is where completion holds up.

### Seeded defaults matter more than they look

A brand-new tenant must be able to run payroll **without configuring anything**. Every default in the config registry (`configurability.md` §3) is chosen so the seeded tenant is immediately correct for the ICP. The configurability requirement is about letting customers change things — not about forcing them to.

---

## 3. Plans and entitlements

```sql
CREATE TABLE control_plane.plans (
  code text PRIMARY KEY,                   -- trial|starter|growth|professional|enterprise
  name text NOT NULL,
  base_price_paise bigint NOT NULL,
  per_employee_price_paise bigint NOT NULL,
  min_employees int NOT NULL DEFAULT 1,
  features jsonb NOT NULL,                 -- {"payroll":true,"helpdesk":false,...}
  limits jsonb NOT NULL,                   -- {"employees":100,"storage_gb":20,"api_rpm":300}
  billing_period text NOT NULL DEFAULT 'monthly',
  status text NOT NULL DEFAULT 'active'    -- grandfathered plans stay readable forever
);

CREATE TABLE control_plane.subscriptions (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL UNIQUE,
  plan_code text NOT NULL REFERENCES control_plane.plans(code),
  status text NOT NULL,                    -- trialing|active|past_due|suspended|cancelled
  trial_ends_on date,
  current_period_start date NOT NULL, current_period_end date NOT NULL,
  billed_employee_count int,               -- snapshot at invoice time
  feature_addons jsonb NOT NULL DEFAULT '{}',   -- per-deal overrides
  limit_overrides jsonb NOT NULL DEFAULT '{}',
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**Entitlement projection.** `tenant_entitlements` in the application plane is a *derived projection* of `plans + subscription + addons`, rewritten by the control plane whenever any input changes, in one transaction that also bumps the tenant's config version. This is the fix for the classic failure where billing, flags and access drift apart and a tenant keeps a feature after downgrading — or loses one after upgrading.

Commercial shape, per the original proposal and still right:

```
base subscription  +  per active employee/month  +  premium modules  +  usage (AI, SMS, WhatsApp)
```

"Active employee" needs a **precise, published definition** — an employee with `status = 'active'` on the last day of the billing period — because it is the number the customer will audit.

### Limit enforcement

Limits degrade politely and never destroy data:

| Limit hit | Behaviour |
|---|---|
| Employee count exceeded | Existing employees keep working; **adding** is blocked with an upgrade path. Payroll never stops. |
| Storage exceeded | Uploads blocked; existing files readable |
| API rate exceeded | 429 with `Retry-After` |
| Trial expired | Read-only for 30 days, then suspended, then per §6 |

**Payroll must never be blocked by a billing state mid-run.** A run that is already frozen completes even if the subscription lapses. Holding an employee's salary hostage to a customer's card failure is not acceptable, and the invoice is recoverable by other means.

---

## 4. Billing

Razorpay primary (India: UPI, netbanking, cards, and it handles GST invoicing), Stripe reserved for international.

```sql
CREATE TABLE control_plane.invoices (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  invoice_number text NOT NULL UNIQUE,
  period_start date NOT NULL, period_end date NOT NULL,
  line_items jsonb NOT NULL,
  subtotal_paise bigint NOT NULL, tax_paise bigint NOT NULL, total_paise bigint NOT NULL,
  gstin text, place_of_supply text,
  status text NOT NULL,                    -- draft|issued|paid|overdue|void|written_off
  due_on date, paid_at timestamptz,
  gateway_invoice_id text, document_object_key text
);

CREATE TABLE control_plane.payment_events (   -- append-only, gateway webhooks
  id bigserial PRIMARY KEY, tenant_id uuid,
  gateway text NOT NULL, gateway_event_id text NOT NULL UNIQUE,   -- idempotency
  event_type text NOT NULL, payload jsonb NOT NULL,
  processed_at timestamptz, processing_error text,
  received_at timestamptz NOT NULL DEFAULT now()
);
```

Webhooks are **signature-verified, idempotent by `gateway_event_id`, and stored before processing**. Payment webhooks arrive out of order and more than once; a system that processes them inline and discards them cannot be reconciled.

GST: PEPL charges 18% on SaaS; place of supply and the customer GSTIN determine CGST/SGST versus IGST, and the invoice must carry both GSTINs. Worth getting right at launch — retrofitting tax onto issued invoices is unpleasant.

**Dunning:** day 1 / 3 / 7 / 14 reminders → day 15 read-only → day 30 suspended. Every step notifies the tenant admin and is reversible on payment.

---

## 5. Platform admin console

For our staff, permission-gated with its own roles (`support`, `billing`, `engineer`, `admin`), every action audited to `control_plane.audit`.

```
Tenants        list, search, health, plan, employee count, last payroll run,
               provisioning status, open tickets
Subscriptions  plan changes, addons, credits, trial extensions
Invoices       issue, void, retry, write off
Usage          per-tenant metering: employees, storage, API, AI tokens, SMS/WhatsApp
Release flags  per-flag: global, cohort, per-tenant, kill switch
Support        platform tickets, access grants, session recordings
Health         error rates, job queue depth, payroll failures by tenant
Announcements  platform-wide maintenance and release notices
Audit          everything our staff did, forever
```

**Release flags** are the platform's own layer-2 control (`configurability.md` §1): staged rollout of a new payroll engine tenant by tenant, and an instant kill switch when a defect appears mid-cycle. An OpenFeature-shaped interface is used here so a provider can be swapped later without touching call sites — but entitlements are **not** a flag vendor's job and stay in our own model.

---

## 6. Tenant lifecycle

```
signup → trialing → active ⇄ past_due → suspended → cancelled → purged
                       ↑                                ↓
                       └──────── reactivation ──────────┘
```

| State | Data | Access |
|---|---|---|
| `trialing` | full | full |
| `active` | full | full |
| `past_due` | full | full, with banner |
| `suspended` | retained | read-only, export still permitted |
| `cancelled` | retained 90 days | export only |
| `purged` | deleted per retention policy | none |

**Export must work in every state up to purge.** A customer who stops paying still owns their payroll records and their statutory obligation to retain them. Withholding data as leverage is unacceptable and, given DPDP, legally exposed. The full-export bundle — employees, attendance, leave, payroll, payslip PDFs, documents, audit — is available self-service, always.

Purge is explicit, two-person approved, and irreversible, with statutory retention honoured (payroll records are retained even after account closure unless the customer's own legal basis permits otherwise).

---

## 7. Trust surface — required at public launch

Selling payroll to companies you have never met means being verifiable by strangers.

| Item | Why |
|---|---|
| Public **status page** with incident history | The first thing a customer checks when payroll is due |
| **Security page**: encryption, isolation model, backups, access control | Every deal above 100 employees asks |
| **Sub-processor list**, with change notification | A DPDP obligation for SaaS vendors, and an enterprise contract requirement |
| **DPA / privacy notice / terms**, versioned, acceptance recorded | The controller/processor relationship must be written down |
| **Grievance officer** contact published | DPDP |
| **Consent and notice** at employee activation, versioned | DPDP notice-and-consent model |
| Uptime commitment, support hours, severity definitions | Sets expectations before they become tickets |

**DPDP timeline note:** the Rules were notified 14 November 2025 with phased implementation — the Data Protection Board and complaint mechanisms live immediately, consent-manager registration from around November 2026, and the substantive obligations landing around **May 2027**. That is a real runway, and it is enough time to build the capabilities in (`tenancy-security.md` §5–6) rather than retrofit them. Retrofitting consent, notice, retention and erasure into a live payroll system is the expensive path.

A specific obligation to design for now: a **separate consent for each secondary purpose** — bundled terms are not sufficient. If PEPL ever wants to use tenant data for model training or benchmarking, it needs its own consent, its own toggle (tenant-editable, default off), and its own record.

---

## 8. Anti-abuse

A public signup form for a payroll product attracts fraud.

- Email verification, disposable-domain blocking, rate limits per IP and per domain
- Card required before the first **payroll run** (not before the trial) — the natural fraud gate, since free attendance tracking is not worth abusing
- Storage and API quotas active during trial
- Anomaly alerts: mass employee creation, unusual export volume, bulk document upload
- Outbound email/SMS/WhatsApp quotas per tenant, so a compromised tenant cannot spam through us

---

## 9. Launch gates

Beyond the product launch gates in [../PRD.md](../PRD.md) §5, public launch additionally requires:

1. Provisioning is fully automated, idempotent and resumable — verified by provisioning 100 tenants in a test run
2. A seeded tenant can complete a payroll run with **zero configuration**
3. Cross-tenant isolation suite green, including config, messaging and helpdesk surfaces
4. Support access grants working, time-boxed, audited, with tenant-visible logs
5. Billing: subscribe, upgrade, downgrade, fail payment, recover, cancel, reactivate — all exercised end to end against the gateway sandbox
6. Self-service full export verified for a 500-employee tenant
7. Point-in-time restore rehearsed, and **single-tenant restore** documented
8. Status page, security page, sub-processor list, DPA and privacy notice published
9. Runbooks: payroll failure during a customer's pay window, suspected isolation incident, gateway outage, mass-signup abuse
10. On-call rota with a defined Sev 1 path — because Sev 1 is "payroll is wrong on the 30th", and that call will come
