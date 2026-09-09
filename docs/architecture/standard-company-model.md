# PEPL — The standard company model

The reference model PEPL is built against: how a typical Indian company actually organises and maintains its workforce system. Every structure below ships as a **default**, and every one is tenant-configurable.

**Design principle:** PEPL encodes the *general* shape that companies share, never one company's policy. Where firms genuinely differ — leave quotas, week patterns, approval depth, whether WFH is paid — that difference is configuration, not code. A product that hardcodes one firm's rules is an internal tool with extra steps.

---

## 1. Organisation structure

The hierarchy nearly every company recognises, though most use only part of it:

```
Company (tenant)
 └── Legal Entity            registered employer: PAN, TAN, PF code, ESI code
      └── Business Unit      optional; division or vertical
           └── Location      registered workplace — drives PT, holidays, shift, geofence
                └── Department
                     └── Team / Sub-department
                          └── Employee
```

Cutting across it:

| Dimension | Purpose |
|---|---|
| **Designation** | Job title — "Senior Accountant" |
| **Grade / Band** | Level for policy and compensation — drives leave quota, approval depth, benefits |
| **Cost centre** | Where the salary cost books |
| **Reporting manager** | The approval chain — usually one, sometimes a dotted second |
| **Employment type** | Permanent · probation · contract · consultant · intern · part-time · retainer |

**What matters architecturally:** a company with 40 employees uses Company → Location → Department → Employee and nothing else. A company with 2,000 uses all of it. **Levels are optional, not skippable-by-convention** — every level has a `nullable` parent and the resolver walks upward to the nearest defined value. Forcing a 40-person firm to invent business units is how HR software earns its reputation.

**Grade is the policy hook.** Companies express most differentiation through it — leave quota, notice period, approval thresholds, expense limits, WFH eligibility. PEPL therefore makes `grade_id` a first-class scope dimension for configuration overrides.

---

## 2. Employee lifecycle

The standard states, and what each means operationally:

```
Candidate → Offered → Pre-joining → Probation → Confirmed → [Transfer / Promotion]
                                        │                          │
                                        └──────────┬───────────────┘
                                                   ▼
                                    Notice → Exited → Full & Final → Alumni
```

| State | Typical rules companies apply |
|---|---|
| **Pre-joining** | Record exists, no attendance, no payroll, document collection runs |
| **Probation** | 3–6 months typical. Often restricted leave, shorter notice, no confirmation-linked benefits |
| **Confirmed** | Full policy applies |
| **Notice** | 30–90 days by grade. Leave often blocked or restricted; exit tasks run |
| **Exited** | Access revoked, FNF computed, records retained for statutory periods |

**Probation and notice periods are grade-scoped configuration**, because that is how companies actually set them — 30 days for junior staff, 90 for management, is the common pattern.

---

## 3. Work calendar

The three patterns that cover nearly all Indian companies:

| Pattern | Weekly off | Who |
|---|---|---|
| **5-day week** | Sat + Sun | IT, corporate offices |
| **6-day week** | Sun | Manufacturing, retail, logistics, most SMEs |
| **Alternate Saturday** | Sun + 2nd/4th Sat | Banking-adjacent, many mid-size firms |
| **Rotational / roster** | Varies by roster | Shifts, support, healthcare, hospitality |

Configured per location and per team, not globally — a single company routinely runs a 5-day head office and a 6-day plant.

### Holidays

```
National holidays        Republic Day · Independence Day · Gandhi Jayanti  (mandatory)
State / festival         varies by state — Pongal, Onam, Durga Puja, Gudi Padwa
Optional / restricted    employee picks N from a list  (very common in India)
Company-declared         founding day, shutdown periods
```

Modelled as: `holiday_calendars` per location and year, with `is_optional` and a per-employee `optional_holidays_allowed` count. The optional-holiday mechanism is near-universal in Indian companies and absent from most imported HR software.

### Shifts

```
General          09:30–18:30, 1 hr break
Fixed multiple   Morning / Evening / Night
Rotational       roster-assigned, published in advance
Flexible         core hours + total-hours requirement
```

Shift assignment resolves **employee override → team/roster → location default**, effective-dated so a change never rewrites past attendance. That resolution order is standard practice, and effective-dating is a hard requirement for any attendance change: a shift edited today must not retroactively make last month's staff late.

---

## 4. Attendance

### Capture

Companies use whatever their workforce and premises allow, usually more than one:

| Method | Typical use |
|---|---|
| **Biometric device** | Factory, office entrance — still the most common in India |
| **Mobile GPS + geofence** | Field staff, sales, multi-site |
| **Web punch** | Desk staff |
| **Access-card / turnstile feed** | Larger offices |
| **Manual / muster** | Small firms, fallback when devices fail |

PEPL supports several concurrently and reconciles them per day. **Manual marking must always exist as a fallback** — every device fails eventually, and a system with no manual path stops payroll when it does.

### The day model

A day resolves to a **status** plus **independent attributes**:

```
status:      present | absent | weekly_off | holiday | on_leave | on_duty | not_joined
attributes:  day_fraction (1.00 / 0.50 / 0.00)
             is_remote        (work from home)
             is_field_duty    (client site, off-premise)
             is_overtime      + minutes
             is_regularized   + who, why
```

Keeping remote/field as **attributes rather than statuses** is the standard-correct model: a person can be remote *and* half-day, or on-duty *and* on a holiday. Encoding them as status values forces false choices and produces reporting collisions.

### Rules companies routinely configure

Grace period · late-mark thresholds and consequences · minimum hours for full day · minimum hours for half day · maximum working hours · break deduction · overtime eligibility and rate · continuous-absence handling · regularization window and monthly limit.

**Half-day determination:** two accepted practices exist —
- **Hours-derived** — worked hours below a threshold auto-marks half-day
- **Explicitly marked** — a manager or HR marks it

PEPL supports both, tenant-selectable, defaulting to **explicit**. Auto-derivation is offered because plenty of companies want it, but it should not be the default: a strict hours rule turns an unusual commute into a pay cut and generates disputes. Whichever is chosen, the resulting fraction is recorded with its source.

### Overtime

```
Eligibility     by grade / employment type — managers usually excluded
Trigger         hours beyond shift, or work on a weekly off/holiday
Rate            commonly 2× ordinary wages for covered workers under
                the Factories Act; companies also use 1× or 1.5× for exempt staff
Compensation    paid OT  |  compensatory off  |  both, by policy
Approval        pre-approved or post-approved — pre-approval is more common
```

### Compensatory off

Standard practice where employees work a weekly off or holiday: a credit is earned, it has an expiry (commonly 30–90 days), and it is consumed as leave. Whether it is *earned automatically* or *requires approval* differs by company and is configurable — auto-credit is the simpler default, approval-gated the stricter one.

---

## 5. Leave

### Statutory baseline

Leave in India is governed by state Shops & Establishments Acts and the Factories Act, so **entitlements vary by state** and by whether the establishment is a shop, an office or a factory. A widely used baseline is:

| Type | Common baseline | Notes |
|---|---|---|
| **Earned / Privilege (EL/PL)** | ~18 days/year under many state Shops Acts | Eligibility commonly tied to ~240 days worked; carry-forward often capped around 30 days; usually encashable |
| **Casual (CL)** | ~7 days/year | Typically lapses annually; often cannot be combined with EL or SL |
| **Sick (SL)** | ~7 days statutory; **12 is a common company practice** | Varies by state; some states use a combined CL+SL structure or part-pay |
| **Maternity** | 26 weeks (Maternity Benefit Act) for the first two children | Central statute, not state-varying |
| **Paternity** | No private-sector statutory entitlement | Company policy — commonly 5–15 days |
| **Compensatory off** | Not statutory | Policy, per §4 |
| **Loss of Pay (LOP)** | — | The fallback when balance is exhausted |
| **Bereavement / marriage / sabbatical** | Not statutory | Company policy, increasingly common |

> These are **defaults to seed a new tenant**, not rules PEPL enforces. State variation is real and the tenant's own policy governs. PEPL's job is to make the configured policy computable and auditable — not to assert what the law requires. Where a tenant's policy falls below a statutory floor, the correct behaviour is to surface a warning, not to block.

### Policy mechanics companies configure

```
Accrual          monthly | quarterly | annual | on-joining | per-days-worked
Proration        for joiners and leavers
Leave year       calendar (Jan–Dec) or financial (Apr–Mar) — both common
Carry forward    limit + expiry window
Encashment       eligibility, basis (basic or gross), timing (annual or at exit)
Negative balance allowed or not
Application unit full day | half day | hourly
Restrictions     probation, notice period, minimum tenure, blackout periods
Sandwich rule    whether intervening offs/holidays count as leave
Notice           advance days required; backdating window
Documentation    medical certificate after N consecutive sick days
Eligibility      by grade, location, employment type, gender (maternity/paternity)
```

The **sandwich rule** deserves explicit support because it is contentious and varies sharply: some firms count a Sunday between two leave days as leave, others do not. It must be a visible setting, not an implementation detail.

### Leave year rollover

The annual process every company runs, and the one most often broken in HR software:

```
Year end → compute closing balance
         → carry forward up to the cap
         → lapse the remainder        (recorded, not silently dropped)
         → encash where policy allows → payroll input
         → open the new cycle with opening balances
```

Because balances derive from an append-only ledger, the rollover **writes entries** — carry-forward, lapse, opening — rather than resetting counters. A rollover that can fail silently is how a company discovers in January that nobody can apply for leave.

---

## 6. Compensation and payroll

### How companies structure salary

```
CTC (annual)
 ├── Fixed
 │    ├── Basic                 typically 40–50% of CTC
 │    ├── HRA                   typically 40–50% of Basic
 │    ├── Conveyance / Transport
 │    ├── Special Allowance     the balancing component
 │    └── Other allowances      medical, education, LTA, telephone
 ├── Variable                   performance bonus, incentive, commission
 └── Employer contributions     PF (employer), ESI (employer), gratuity provision
```

Whether employer PF and gratuity sit *inside* or *outside* CTC differs by company and materially changes the offer — it is an explicit tenant setting, not an assumption.

**Special Allowance as the balancing component** is near-universal Indian practice: fixed components are computed from CTC, and Special Allowance absorbs the remainder so the structure sums exactly.

### Statutory deductions

| Item | Standard treatment |
|---|---|
| **Provident Fund** | 12% employee + 12% employer on PF wages; wage ceiling applies unless the company opts to contribute on full wages; employer share splits into EPF and EPS |
| **ESI** | Applies below a gross threshold; **an employee who crosses the threshold mid-contribution-period continues until the period ends** — the most commonly mis-implemented rule in Indian payroll |
| **Professional Tax** | State-specific slabs; some states have a different amount in one month of the year |
| **Income Tax (TDS)** | Old or new regime per employee election, projected annually and spread across remaining months |
| **Labour Welfare Fund** | Applicable in some states, usually half-yearly or annual |
| **Gratuity** | Payable after 5 years of continuous service; commonly `15/26 × last drawn (Basic+DA) × completed years` |

Rates and slabs are **platform-maintained reference data with effective dates**, snapshotted into each payroll run. A tenant may override with an explicit, acknowledged, audited deviation — but the shipped defaults are current and correct so the majority who never touch them stay compliant.

### The payroll cycle companies run

```
Attendance cutoff       usually 25th–末, varies by company
Inputs finalised        attendance, leave, LOP, OT, variable pay, one-offs
Compute → verify        against the previous month, employee by employee
Approve                 usually HR/finance, separate from whoever ran it
Lock
Disburse                bank file or payout; salary date commonly 1st–7th
Statutory filings       PF ECR, ESI, PT, TDS (24Q quarterly), LWF
Distribute payslips
```

The **arrears** case is routine and must be first-class: a revision approved after payroll closed pays in the following month, with the arrear shown as its own line.

---

## 7. Approvals and authority

The standard chain, and how companies vary it:

```
Employee → Reporting Manager → [Department Head] → [HR] → [Finance]
```

| Request | Common chain |
|---|---|
| Leave (short) | Manager |
| Leave (long, > 5 days) | Manager → HoD or HR |
| Attendance regularization | Manager |
| Work from home | Manager |
| Overtime | Manager → HR |
| Expense claim | Manager → Finance, with amount thresholds |
| Salary revision | HoD → HR → Finance/MD |
| Payroll run | Payroll → HR/Finance (never the same person) |
| Exit / resignation | Manager → HR |

Standard behaviours companies expect: **send back for correction** (not just approve/reject), **delegation while an approver is on leave**, **escalation after an SLA**, **auto-approval within thresholds**, and **skip-level routing** when the approver is the requester or has left.

**Segregation of duties** is the one companies are audited on: the person who prepares payroll must not be the person who approves it, and neither should be the person who releases payment.

---

## 8. Roles companies actually use

| Role | Typical scope |
|---|---|
| **Employee** | Own record, own requests |
| **Manager** | Their reports: attendance, leave approval, no compensation visibility |
| **Department Head** | Their department, aggregate views |
| **HR Executive** | Employee records, attendance, leave — often *without* salary |
| **HR Manager / Head** | Full HR including compensation |
| **Payroll Officer** | Payroll processing, compensation — often *without* employee record editing |
| **Finance** | Payroll cost, payments, reports |
| **Auditor** | Read-only, everything |
| **Company Admin** | Configuration, roles, integrations |

**The critical boundary: a manager sees attendance and leave, never salary.** This is the single most common access-control expectation in HR systems, and the most common place they get it wrong — a "view employee" screen that quietly includes compensation because the record contains it. PEPL enforces it at the service boundary: compensation fields require `compensation.read`, evaluated independently of record access.

---

## 9. Cycles and calendars

| Cycle | Typical setting |
|---|---|
| Financial year | April–March |
| Leave year | Calendar or financial — both common, configurable |
| Attendance cycle | 26th–25th, or calendar month |
| Payroll cycle | Monthly; salary date 1st–7th |
| Appraisal cycle | Annual, often April; some run half-yearly |
| Increment effective | Commonly April or July |
| Probation review | 3 or 6 months from joining |
| Statutory filings | PF/ESI monthly · PT monthly or as per state · TDS quarterly |

Every one is tenant configuration. Getting the attendance-cycle boundary wrong is the most common cause of first-month payroll disputes, so onboarding asks it explicitly rather than assuming.

---

## 10. Registers and documents companies must maintain

Standard statutory and practical record-keeping, all produced from data PEPL already holds:

```
Attendance register · Wage register · Leave register · Overtime register
Muster roll · Form 16 · PF ECR · ESI contribution · PT returns · TDS 24Q
Appointment / offer / confirmation / increment / relieving / experience letters
Employee personnel file: IDs, education, experience, contracts, acknowledgements
```

Retention runs to several years by statute — which is why records are never hard-deleted, only anonymised after the statutory window.

---

## 11. How this becomes PEPL

Every structure in this document maps to a configuration key with a sensible default, so a new tenant is immediately correct without configuring anything, and can change anything they need to.

| Standard model | PEPL mechanism |
|---|---|
| Org hierarchy with optional levels | Nullable parents; resolver walks upward |
| Grade-driven policy | `grade` is a first-class override scope |
| Week patterns, shifts, holidays | Per-location calendars, effective-dated |
| Day status vs. attributes | `status` + independent `day_fraction`, `is_remote`, `is_field_duty` |
| Leave policies | Versioned policies; balances from an append-only ledger |
| Salary structures | Components with a balancing allowance |
| Statutory rates | Platform reference data with effective dates, snapshotted per run |
| Approval chains | Composed per module and per scope from a fixed step vocabulary |
| Role boundaries | Permission strings asserted at the service boundary |
| Cycles | Tenant configuration, asked during onboarding |

**The test of this model:** a 40-person trading firm in Coimbatore and a 900-person manufacturer in Pune should both be able to run their first payroll on PEPL without a customisation request — one by accepting the defaults, the other by configuring within them.
