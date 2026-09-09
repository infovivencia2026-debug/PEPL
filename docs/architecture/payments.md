# PEPL — Payments

Three distinct money flows. They share a ledger discipline and nothing else.

| Flow | Direction | Owner |
|---|---|---|
| **A. Salary disbursement** | Tenant → their employees | Payroll module |
| **B. Employee money** | Tenant → employee, off-cycle: reimbursements, advances, loans, incentives | Expense/payroll |
| **C. Subscription billing** | Tenant → PEPL | Control plane (`platform-control-plane.md` §4) |

**PEPL never holds customer money.** No escrow, no pooled account, no wallet. Salary moves from the tenant's own bank account to their employees, either by a file they upload to their bank or by an API call authorised by their own credentials. This keeps PEPL out of payment-aggregator regulation entirely, and it is the correct posture for a payroll product.

---

## 1. The governing risk

**Double payment.** A retried request, a duplicated file upload, or an ambiguous API timeout can pay 500 people twice. Unlike most software errors this one is not fully recoverable — recovering an overpayment from an employee is a legal and human problem, not a database fix.

Every design decision below follows from that.

---

## 2. Salary disbursement

### Two channels, same ledger

```
LOCKED payroll run
        │
        ├──► BANK FILE     (default — works with every Indian bank)
        │      generate → checksum → download → tenant uploads to their bank portal
        │      → tenant records the outcome (or uploads the bank's response file)
        │
        └──► PAYOUT API    (optional, per tenant)
               RazorpayX · ICICI Connected Banking · HDFC · Yes Bank
               → PEPL submits instructions using the TENANT's credentials
               → webhook reconciliation
```

**Bank file is the default and must always work.** API payouts are a convenience that a minority of tenants will configure; a file is what the other majority actually use, and it degrades to a manual process that cannot silently double-pay.

### Payment instructions — one row per employee per run

```sql
CREATE TABLE payment_batches (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  source_type text NOT NULL,        -- payroll_run | reimbursement | advance | incentive
  source_id uuid NOT NULL,
  channel text NOT NULL,            -- bank_file | payout_api
  bank_account_id uuid NOT NULL,    -- the tenant's debit account
  value_date date NOT NULL,
  instruction_count int NOT NULL, total_paise bigint NOT NULL,
  status text NOT NULL DEFAULT 'draft',   -- draft|ready|submitted|partially_settled
                                          -- |settled|failed|cancelled
  idempotency_key text NOT NULL,
  file_object_key text, file_checksum_sha256 text,
  generated_by_user_id uuid NOT NULL, approved_by_user_id uuid,
  submitted_at timestamptz, settled_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_type, source_id, channel)   -- ONE batch per run per channel
);

CREATE TABLE payment_instructions (
  tenant_id uuid NOT NULL, id bigserial,
  batch_id uuid NOT NULL, employee_id uuid NOT NULL,
  beneficiary_name text NOT NULL,
  account_number_enc bytea NOT NULL, ifsc text NOT NULL,
  amount_paise bigint NOT NULL,
  mode text NOT NULL,               -- NEFT | IMPS | RTGS | UPI
  reference text NOT NULL,          -- appears on the employee's statement
  status text NOT NULL DEFAULT 'pending',  -- pending|submitted|settled|failed|returned
  utr text,                         -- bank's transaction reference
  failure_code text, failure_reason text,
  provider_instruction_id text,
  settled_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, batch_id, employee_id)
);

CREATE TABLE payment_events (       -- append-only: webhooks, file responses, manual marks
  tenant_id uuid NOT NULL, id bigserial,
  batch_id uuid, instruction_id bigint,
  event_type text NOT NULL, source text NOT NULL,   -- webhook|response_file|manual|api_poll
  provider_event_id text, payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source, provider_event_id)     -- webhooks arrive twice
);
```

### The rules

1. **`UNIQUE (tenant_id, source_type, source_id, channel)`** — a payroll run can produce exactly one batch per channel. Generating twice returns the existing batch, it does not create a second one. This is the structural defence against double payment, at the database level rather than in a handler.
2. **Only a `locked` run can produce a batch.** A draft or revised-but-unlocked run cannot pay anyone.
3. **Regenerating a file returns the same file** — same content, same checksum — unless the batch is explicitly cancelled first, which requires a reason and is audited.
4. **Separation of duty**: whoever generated the batch cannot approve its submission.
5. **A revision after payment never re-pays.** The delta goes to the next period as an arrear (`payroll.md` §3). A locked, paid run is final.
6. **Failed instructions are re-issued individually**, never by regenerating the batch. A `returned` payment (wrong IFSC, closed account) creates a new single-instruction batch after the bank details are corrected.
7. **Amounts come from `payroll_lines`**, never recomputed at payment time. The engine decides what is owed; the payment layer only moves it.

### Bank file formats

Per-bank templates in configuration, not code:

```sql
CREATE TABLE bank_file_formats (
  id uuid PRIMARY KEY, code text NOT NULL,   -- hdfc_neft_csv | icici_fixed | axis_xlsx
  bank_name text NOT NULL, file_type text NOT NULL,
  column_spec jsonb NOT NULL,     -- ordered fields, widths, date/amount formats
  header_spec jsonb, footer_spec jsonb,
  amount_unit text NOT NULL,      -- rupees_2dp | paise
  status text NOT NULL DEFAULT 'active'
);
```

Expect to add one format per bank for the first several customers. Budget for it — it is the most common onboarding blocker in Indian payroll, and it is data entry, not engineering, once the template engine exists.

### Reconciliation

```
Submitted  →  webhook / response file / manual mark
                     ↓
        per-instruction: settled (UTR recorded) | failed | returned
                     ↓
        batch rolls up: settled | partially_settled | failed
                     ↓
        unreconciled after N hours → alert, never auto-retry
```

**Never auto-retry a payment on timeout.** An ambiguous submission is resolved by *querying* the provider for the instruction's status using our idempotency key, never by resubmitting. This is the single most important operational rule in this document.

The payslip shows payment status and UTR once settled, which removes the most common "has my salary been sent?" ticket entirely.

---

## 3. Employee money (off-cycle)

Reimbursements, salary advances, loans and incentive payouts share one shape:

```sql
CREATE TABLE employee_payables (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  kind text NOT NULL,               -- reimbursement | advance | loan_disbursement
                                    -- | incentive | bonus | fnf
  amount_paise bigint NOT NULL,
  taxable boolean NOT NULL DEFAULT false,
  settlement text NOT NULL,         -- with_payroll | off_cycle
  approval_request_id uuid,
  payroll_run_id uuid,              -- when settled with payroll
  payment_instruction_id bigint,    -- when paid off-cycle
  status text NOT NULL DEFAULT 'pending',
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE employee_loans (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  principal_paise bigint NOT NULL, interest_rate numeric(5,2) NOT NULL DEFAULT 0,
  instalment_paise bigint NOT NULL, instalments_total int NOT NULL,
  instalments_paid int NOT NULL DEFAULT 0,
  outstanding_paise bigint NOT NULL,
  start_period text NOT NULL, status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (tenant_id, id)
);
```

- `settlement = with_payroll` → flows into `payroll_inputs.adhoc` before freeze. The default, and the simplest.
- `settlement = off_cycle` → its own single-instruction batch, same ledger, same idempotency.
- **Loan recovery is a payroll deduction**, and the outstanding balance is reduced *only when the run locks* — never at calculation time, or an unlocked-then-recalculated run corrupts the balance.
- **Taxability is explicit per payable.** A reimbursement against a bill is not taxable; a bonus is. Getting this wrong misstates TDS.
- Exit triggers full recovery of outstanding loans and advances into FNF.

---

## 4. Configuration

| Setting | Default |
|---|---|
| `payments.channel` | `bank_file` |
| `payments.bank_format` | — (set at onboarding) |
| `payments.payout_api_provider` | none |
| `payments.require_separate_approver` | **on** |
| `payments.default_mode` | NEFT |
| `payments.allow_off_cycle` | on |
| `payments.reconciliation_alert_hours` | 24 |
| `payments.salary_account_masking` | last 4 only |

Payout-API credentials are the tenant's own, stored with the same per-tenant envelope encryption as mail credentials (`mail.md` §7), used only inside the payment worker, never logged, and revocable by the tenant at their bank.

---

## 5. Auditing

Every step emits to the company activity log (`activity-log.md`): batch generated, approved, submitted, each settlement and failure, every file download with its checksum, every credential change, every cancellation with its reason.

`payroll.bankfile.generated` and `.downloaded` are high-severity events that trigger the admin alert — a bank file is a list of every employee's account number and salary, and it leaving the system should never be quiet.
