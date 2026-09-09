# PEPL — Product requirements (Release 1.0)

**Status:** full scope for the single public launch. No staged public releases.
**ICP:** India-registered companies, 30–500 employees, single legal entity, salaried monthly payroll
**Definition of done:** a company that signed up without talking to us imports its employees, configures its own policies, and runs a correct, locked, paid payroll — with no spreadsheet and no support ticket.

---

## 1. Scope

**Everything ships before launch.** The waves in [README](README.md) are build order, not release milestones.

| Area | Included |
|---|---|
| Platform | Multi-tenancy · RLS isolation · custom roles · custom fields · full configuration layer |
| Control plane | Self-serve signup · provisioning · plans · entitlements · billing + GST · dunning · platform support desk · support access grants |
| Core HR | Bitemporal employees · org hierarchy · assignments · compensation · documents · letter templates · import |
| Workforce | Calendars · shifts · rosters · attendance capture (biometric, mobile GPS/geofence, web, manual) · corrections · regularization · overtime |
| Leave | Configurable types and versioned policies · ledger balances · comp-off · rollover · encashment |
| Approvals | Configurable chains per module and scope · delegation · escalation · unified inbox |
| Payroll | Structures · statutory (PF/ESI/PT/TDS/LWF/gratuity) · input freeze · runs · revisions · immutability · payslips · FNF |
| Payments | Bank files · payout API adapters · reimbursements · advances · loans · reconciliation |
| Work | Tasks · onboarding/offboarding · activities/field duty · incentives · expenses |
| Helpdesk | Categories · SLA · routing · escalation · confidential categories · knowledge base |
| Comms | Mail client · chat · announcements · notifications |
| Audit | Company activity log · tamper evidence · retention · legal hold |
| Clients | Web console · mobile employee app |

Deliberately **not** in the launch, and recorded as such: recruitment/ATS · performance and OKRs · learning · a general workflow/formula builder · SSO/SCIM · multi-state payroll beyond the launch states · AI copilot. Each has a seam recorded in [architecture/api-boundaries.md](architecture/api-boundaries.md) §5.

---

## 2. Seeded roles (tenants may create their own)

| Role | Grants |
|---|---|
| `org_admin` | everything in the tenant |
| `hr_admin` | employee.*, attendance.*, leave.*, document.*, approval.act, audit.read |
| `payroll_admin` | payroll.*, compensation.read/write, employee.read, bank.export |
| `finance` | payroll.read, bank.export, report.read |
| `manager` | employee.read (own reports), attendance.approve, leave.approve, approval.act (own queue) |
| `employee` | *.self |

No custom-role UI. Authorization is evaluated against permission strings (`payroll.process`), never role names — so the custom-role feature is later a UI over an existing mechanism. See `architecture/api-boundaries.md` §2.

---

## 3. The monthly cycle (the spec that matters)

```
1..N   Employees punch (mobile/web) or biometric file is imported nightly
       → attendance_punches (raw, append-only)
       → daily_attendance recomputed (derived, idempotent)

~25th  HR closes attendance for the period
       Regularizations after this date land in the NEXT period
       → attendance_period.status = closed

~26th  Payroll input freeze
       Snapshot: paid days, LOP days, OT hours, leave consumed,
                 compensation effective on period end, active statutory config
       → payroll_inputs (immutable rows, tied to run revision)

~27th  Payroll calculation → validation → HR review
       Validation blocks the run on: negative net pay, missing PAN/UAN/bank,
       LOP > paid days, CTC change mid-period without effective date,
       variance vs prior month > configured threshold

~28th  Approval → LOCK
       Locked run is immutable. Corrections create revision N+1
       carrying a signed delta against revision N.

~1st   Bank file export + payslip PDFs published to ESS
```

**Hard rule:** payroll never reads `attendance_punches` or `daily_attendance` directly. It reads `payroll_inputs`, which is written once per revision by an explicit freeze step.

---

## 4. Fixed screens

**Web (HR/admin operations surface)**
Dashboard · Employees (list, profile, history tabs) · Org setup · Import · Attendance (daily grid, regularizations, shifts, holidays) · Leave (requests, policies, balances) · Approvals inbox · Payroll (periods, runs, inputs, review, payslips, bank file) · Documents · Audit log · Settings

**Mobile (employee action surface — six screens, no more)**
Home (punch + today) · Attendance · Leave · Payslips · Profile & documents · Approvals (managers only)

Detailed screen contracts: `architecture/screens.md`.

---

## 5. Launch gates (product)

| Gate | Threshold |
|---|---|
| Tenant isolation | Cross-tenant test suite green; CI fails on any tenant-scoped table lacking `FORCE ROW LEVEL SECURITY` + policy |
| Payroll correctness | Golden-file suite: 40 employee scenarios (LOP, mid-month join/exit, arrears, PF ceiling, ESI threshold crossing, PT slab boundary) matched to hand-computed expected output |
| Payroll immutability | Test asserting any write to a locked run raises, at the DB level, not just the service layer |
| Audit completeness | Test asserting every write path on employee/compensation/payroll emits an `audit_event` |
| Import | 500-row real customer sheet imports with per-row error report, zero partial commits |
| Mobile punch | Works offline-queued; duplicate punch within 60s deduped server-side |
| Restore | Documented and rehearsed point-in-time restore of one tenant's data |

---

## 6. Open decisions (do not block the schema)

1. **Launch state for PT.** PT slabs are per-state and are modelled as data (`pt_slabs`), not code, so the launch state is a config row, not an architecture choice. Pick it from the first customer.
2. **TDS depth.** Projected-annual TDS under both regimes from declared investments is in scope. Form 16 generation and 24Q return filing are the open question — customers ask on the first call, so decide before launch rather than after.
3. **Biometric device coverage.** Which device vendors and file formats are supported at launch (eSSL, Realtime, ZKTeco cover most of the Indian market). It is the only capture method with a hardware dependency, and the only one that needs per-vendor work.
