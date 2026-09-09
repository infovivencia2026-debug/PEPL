# PEPL API — handoff for the UI build

Everything a frontend needs. The backend is complete and tested; this document is
the contract.

---

## Start it

```bash
npm install
npm run db:setup      # roles + database + extensions (needs a local Postgres)
npm run migrate       # 19 migrations
npm run seed:demo     # a realistic 8-person company
npm run api           # http://localhost:4010
npm run openapi       # regenerates openapi.json from the live route table
```

`openapi.json` is **generated from the router**, so it cannot drift from what the
server serves. Regenerate it rather than editing it.

## Demo logins

Password for every account: `demo-password-2026`

| Email | Role | What they can see |
|---|---|---|
| `admin@acme.test` | org_admin | Everything |
| `priya@acme.test` | hr_admin | People, attendance, leave — **not salary** |
| `anil@acme.test` | payroll_admin | Payroll and compensation |
| `arjun@acme.test` | manager | His own reports only |
| `rahul@acme.test` | employee | His own record only |

Log in as each of these while building. The permission model is real, and a screen
that looks right as `admin` will be empty or 403 as `employee` — which is the
correct behaviour, not a bug.

---

## The four rules that shape every screen

### 1. Call `GET /api/v1/me` first, and render from it

```json
{
  "userId": "…", "employeeId": "…",
  "roles": ["hr_admin"],
  "permissions": ["employee.read", "leave.approve", "…"],
  "scope": "all",
  "modules": { "leave": true, "attendance": true, "payroll": true, "helpdesk": false },
  "limits": { "employees": 1000 },
  "configVersion": "7"
}
```

**Drive navigation from `permissions` and `modules`, never from `roles`.** A tenant
can define custom roles with any name, so a role-name switch will be wrong for real
customers. `modules` reflects both what the company has enabled and what its plan
includes.

A disabled module returns `403 MODULE_NOT_AVAILABLE`. **Hide it** rather than
showing a disabled teaser — the company has decided it does not use that module.

### 2. Errors carry a stable code — switch on that

```json
{ "error": { "code": "CONFIG_EFFECTIVE_DATE_REQUIRED",
             "message": "…must carry an effective date, so a locked run stays reproducible",
             "details": { "missing": ["employeeNumber"] },
             "requestId": "…" } }
```

`message` is written to be shown to a user as-is. `requestId` correlates with the
server log — surface it in an error toast so support can trace it.

Codes worth handling specially:

| Code | Status | What the UI should do |
|---|---|---|
| `VALIDATION_FAILED` | 422 | Highlight the fields in `details.missing` |
| `PERMISSION_DENIED` | 403 | Should not happen if you rendered from `permissions` — treat as a bug |
| `MODULE_NOT_AVAILABLE` | 403 | Hide the feature |
| `NOT_FOUND` | 404 | Also returned for a record outside the caller's scope. Do not say "forbidden" |
| `PERIOD_CLOSED` / `CONFIG_LOCKED_PERIOD` | 409 | Explain the period is closed and offer the next one |
| `SEPARATION_OF_DUTY` | 409 | "The person who ran this payroll cannot approve it" |
| `INSUFFICIENT_BALANCE` | 409 | Show the balance and the shortfall |
| `EMPLOYEE_LIMIT_REACHED` | 403 | Offer an upgrade; existing employees still work |
| `ACCOUNT_LOCKED` | 429 | Show the cooldown |

### 3. Reasons are mandatory where money or history moves

Compensation changes, corrections, payroll revisions, balance adjustments and
high-risk config changes all require `reason`. Make it a required field with real
placeholder text, not an optional note — the API will reject the request without it,
and the reason appears in the activity log forever.

### 4. Tenancy is invisible

There is no tenant id in any URL, header or body. The company is resolved from the
session. Do not build a tenant switcher.

---

## Screens the API is shaped for

**Employee list / profile.** `GET /employees` is already scoped — a manager gets
their reports, an employee gets themselves. Do not filter client-side.
`GET /employees/:id` omits `annual_ctc_paise` entirely for a caller without
`compensation.read`; render the section only when the field is present.

**The effective-dated change form** is the most important interaction in the product.
Every assignment or compensation change needs *what changed*, *effective from when*,
and *why*. Show a preview line — "Effective 1 Oct: Senior Developer → Lead Developer.
This does not affect September payroll." A form that lets someone change a field
without a date defeats the entire history model.

**Corrections are a different action from changes.** "This was recorded incorrectly"
uses `/correct` and means something different from a change. Different copy, different
button.

**Leave balances** return four numbers — `opening`, `accrued`, `consumed`, `available`
— plus a ledger endpoint that explains them. Make the balance a link to the ledger.
"Why is my balance 4.5?" should never become a support ticket.

**The inbox** (`GET /api/v1/inbox`) is one queue of approvals *and* tasks across every
module. Do not build separate screens per module — that is the failure that sends
managers back to WhatsApp. Support **send back** as prominently as approve/reject; it
is the most used action in practice.

**Payroll** is a linear stepper: draft → frozen → calculated → validated → approved →
locked. Show blockers in red (they stop progress) and warnings in amber (they need an
acknowledgement). After lock, the button is **Revise**, never Edit.

**Config** (`GET /api/v1/config`) returns every setting with its label, help text,
type, default, current value and `changedFromDefault`. **Generate the settings screens
from this response** rather than hand-coding 25 forms — new settings then appear
automatically. Offer a "show only changed" filter; it is the first thing support asks
for. Settings with `requiresEffectiveDate` must show a date picker defaulting to the
start of next month.

**Attendance** days carry a `status` plus independent attributes (`is_remote`,
`is_field_duty`, `day_fraction`). A day can be remote *and* half-day — render the
fraction and the remote mark separately, never as one letter.

---

## Money and dates

- **All money is an integer string of paise.** `"120000000"` is ₹12,00,000. Never
  parse it as a float; format for display with the Indian grouping (`1,20,000`).
- **Dates are `YYYY-MM-DD` strings.** Timestamps are ISO-8601 UTC.
- **`day_fraction`** is `1`, `0.5` or `0`.

---

## Auth

```
POST /api/v1/auth/login  { email, password }  ->  { token, expiresAt, user }
Authorization: Bearer <token>   on every other request
POST /api/v1/auth/logout                      revokes immediately
```

Tokens are opaque and server-side; logout takes effect at once. On any `401`, drop the
token and return to login.

---

## What is NOT built

Be explicit so nothing is assumed present:

- **No payslip PDF.** `GET /payslips/:id/lines` returns the full component breakdown;
  render it, and PDF generation comes later.
- **No file upload / document storage endpoints.**
- **No CSV/Excel import endpoint** (the design exists; the API does not).
- **No realtime.** Chat and notifications are polled; there is no socket yet.
- **No email or push delivery.** Notifications are stored and readable via the API.
- **TDS is a flat-rate placeholder**, not a real projection against tax slabs.
- **No bank-file export endpoint.**

---

## Sanity check

```bash
npm test          # 260 tests, including 33 against the running HTTP API
npm run verify    # every gate, end to end
```

If `npm run verify` is green, the backend is behaving. If a UI call fails, the error
`code` will say why, and it is usually a permission or a module toggle rather than a
bug.
