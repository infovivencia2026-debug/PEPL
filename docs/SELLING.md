# Selling PEPL

For the people who demo it, and the people who invoice for it.

PEPL is sold by salespeople to organisations and paid by bank transfer. There
is no payment gateway and no public signup funnel, deliberately — the product
is shown in a room, and the account is opened by ops afterwards.

---

## 1. The demo company

`npm run seed:demo` builds **Acme Manufacturing Pvt Ltd** and is safe to re-run:
it replaces the previous copy rather than accumulating duplicates.

| | |
|---|---|
| People | 47, across 6 departments and 3 locations (Hyderabad, Pune, Coimbatore) |
| Plan | Enterprise, so every module is visible |
| Payroll | August 2026, **locked** — 47 payslips, gross ₹27,14,742, net ₹26,01,871 |
| Also on file | 31 documents, 15 assets, 9 candidates in the pipeline, 47 appraisals, 4 expense claims |

### Logins

Every account uses the same password: **`demo-password-2026`**

| Email | Role | What they can see |
|---|---|---|
| `admin@acme.test` | Org admin | Everything, including settings, plan and roles |
| `priya@acme.test` | HR admin | People, attendance, leave, documents — **not** salary |
| `anil@acme.test` | Payroll admin | Payroll, compensation, bank export |
| `finance@acme.test` | Finance | Payroll read, approvals, bank export |
| `arjun@acme.test` | Manager | Only his own reports; no compensation |
| `rahul@acme.test` | Employee | Only his own record |
| `auditor@acme.test` | Auditor | Read-only across the company, including the audit log |

Sign in at `http://127.0.0.1:3100` (`npm start`), or `http://127.0.0.1:5173`
during development (`npm run dev` plus `npm run api`).

### Two reps demoing at once

One shared demo company means the first person to approve a leave request
changes what the second one is presenting. Give each rep their own:

```bash
PEPL_DEMO_SUFFIX=ravi npm run seed:demo
```

The company becomes "Acme Manufacturing Pvt Ltd (ravi)" and every login becomes
a plus-address — `admin+ravi@acme.test`, `priya+ravi@acme.test` — because an
email is unique across the whole platform, not just within a company. The seed
prints the suffixed logins. Same password.

### A demo that lands

Sign in as **each** of these in turn — the product looking different per person
is the thing prospects remember, because it is the thing their current system
does not do.

1. **`admin@acme.test` → Overview.** One screen, no scrolling: headcount,
   attendance, leave, payroll, the approval queue.
2. **People → Directory.** 47 real people. Open one: assignment history,
   compensation history, documents, assets.
3. **Payroll → August 2026.** Locked. Walk the stepper: Freeze → Calculate →
   Validate → Approve → Lock. Say the sentence that sells it: *the run was
   processed by Anil and approved by Deepa, and the software refuses to let
   one person do both.* Then try to edit it.
4. **Sign in as `arjun@acme.test`.** The same product, one team, no salaries.
   This is the moment to mention that it is enforced in the database, not in
   the screens.
5. **Sign in as `rahul@acme.test`.** Payslip, leave balance, punch in.
6. **Back as admin → Company → Plan & modules.** What they are on, what the
   next tier adds, priced from the same place the invoice comes from.

---

## 2. The back office

`npm run ops` — for opening accounts, invoicing and recording payment.

A CLI rather than a web console on purpose: every user in PEPL belongs to a
tenant, there is no platform-staff identity, and inventing one would create a
login that can reach every customer's data. Shell access on the server is the
right bar for these operations. Every command lands in
`control_plane.platform_audit`.

```bash
npm run ops tenants                 # every company, plan, headcount
npm run ops show "Acme"             # plan, period, headcount, what is outstanding
npm run ops plans                   # the tiers and their prices
npm run ops revenue                 # MRR by plan, excluding trials and sandboxes
```

### Opening an account after a sale

```bash
npm run ops create \
  --name "Vindhya Textiles Pvt Ltd" \
  --admin-email ops@vindhya.com --admin-name "Lata Rao" \
  --plan growth --state TS --type manufacturing --activate
```

Without `--activate` they get the 14-day trial. It prints a one-time password;
give it to the customer and have them change it at first sign-in.

`--state` is the **place of supply** and it decides the GST on every invoice
they will ever receive. Set it.

### Billing

```bash
npm run ops billing-details "Vindhya" --gstin 36BBBBB1111B1Z5 \
    --address "Plot 9, Jeedimetla, Hyderabad 500055" --state TS
npm run ops close-periods                      # raise invoices for ended periods
npm run ops invoices "Vindhya"
npm run ops invoice-pdf INV-2026-FFF289-00001  # the GST tax invoice, to email
npm run ops pay INV-2026-FFF289-00001 --ref "NEFT UTR SBIN426100234891"
npm run ops void INV-2026-... --reason "billed on the wrong headcount"     # unpaid only
npm run ops dunning                            # overdue → suspend → reactivate
```

Quote `--ref` and `--reason`. The CLI refuses trailing words rather than
silently recording the first one.

**Void or credit?** An invoice raised in error is *voided*, and only while it is
unpaid — it keeps its number and stops being chased. Once the money has arrived
that door is closed: their books and ours both record a real movement, and
making it vanish leaves the two disagreeing. Reducing a paid invoice is a
*credit note*, its own document with its own `CRN-` series, and the total
credited can never exceed the invoice.

**Changing plan mid-period.** An upgrade is charged for the days remaining, at
the difference between the two plans, invoiced at once — otherwise a customer
who upgrades on the 2nd gets the rest of the month free. A downgrade takes
effect at the next period and raises nothing: no refund for service already
delivered.

### Before the first real invoice

Set the supplier's identity in `.env`, or every invoice will print
**"Not a tax invoice"** — which is correct, and not what you want to send a
customer:

```
PEPL_LEGAL_NAME=...
PEPL_ADDRESS=...
PEPL_GSTIN=...
PEPL_STATE_CODE=TS      # decides CGST+SGST against IGST
PEPL_BILLING_EMAIL=...
```

---

## 3. What the plans sell

Set in `control_plane.plans`. Changing a tier is an edit there plus
`npm run job control.reproject_entitlements` — never a deploy.

| | Starter | Growth | Professional | Enterprise |
|---|---|---|---|---|
| Base / month | ₹2,000 | ₹5,000 | ₹12,000 | ₹30,000 |
| Per person | ₹50 | ₹80 | ₹100 | ₹120 |
| People | 25 | 200 | 1,000 | 10,000 |
| Payroll, leave, attendance, documents | ✓ | ✓ | ✓ | ✓ |
| Expenses, timesheets | — | ✓ | ✓ | ✓ |
| Recruitment, performance, assets, learning, surveys | — | — | ✓ | ✓ |
| Integrations | — | — | ✓ | ✓ |
| Own branding and domain | — | — | — | ✓ |

A module the plan does not include answers `PLAN_UPGRADE_REQUIRED`, which is a
different thing from `MODULE_NOT_AVAILABLE` (the company switched it off). The
first is a conversation with you; the second is a settings toggle.

---

## 4. One person, several companies

An accountant, a consultant or a group CFO can hold an account in more than one
company on the same email address. Signing in asks which one:

> **Which company?**
> Alpha Mills Pvt Ltd  ·  Beta Looms Pvt Ltd

Worth knowing when you demo it:

- The question appears **after** the password is correct, never before. A wrong
  password gets the same refusal as any other, so the login form cannot be used
  to find out which companies an address belongs to.
- A session belongs to **one** company. Moving to the other means signing in
  again — nothing is shared between them, and the isolation is the same one
  that separates two unrelated customers.
- Multi-membership happens by **invitation**: an admin adds an address that
  already exists elsewhere. Creating a brand-new company still refuses an
  address already in use.

There is a working example in the dev database: `ramesh@practice.test` /
`consultant-pass-2026` holds an account in both Alpha Mills and Beta Looms.

## 5. Giving a prospect their own sandbox

A customer evaluating PEPL can have a throwaway twin of their own company,
full of sample data, that expires — and which never emails, messages or
webhooks anything to a real person. It is in the product under
**Company → Sandbox**, not here.

---

## 6. What is still missing

Honest list, so nobody promises these in a room:

- **No self-serve plan change.** An upgrade is a conversation with you, then
  `npm run ops plan`. The product shows what each tier includes and will not
  switch itself.
- **The trial banner is admin-only.** Only a holder of `settings.write` sees
  "your trial ends in N days", because only they can read `/billing` and only
  they can act on it. Everyone else finds out when the company is suspended.
- **No marketing site.** `/` is the login screen. Fine while every lead comes
  from a salesperson; not fine the day you want inbound.
