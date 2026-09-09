# PEPL — Support ticket systems

Two distinct desks. They share a schema and a state machine; they must not share a queue, a permission model or a database boundary.

| | **Employee Helpdesk** | **Platform Support Desk** |
|---|---|---|
| Who raises | An employee of a tenant | A tenant admin, to PEPL |
| Who resolves | That tenant's HR / IT / Payroll / Admin teams | Our support team |
| Lives in | Application plane, `tenant_id`-scoped, RLS | Control plane, cross-tenant by design |
| Contains | Salary queries, leave disputes, IT requests, grievances | Bugs, billing, configuration help, onboarding |
| Visibility | Never visible to PEPL staff without an audited access grant | Visible to PEPL staff by design |

Conflating them would put a tenant's harassment complaint in our support inbox. They are separate systems that happen to look alike.

---

## 1. Employee Helpdesk

### Why it belongs in PEPL

Employees currently ask HR about payroll on WhatsApp. Nothing is tracked, nothing is measurable, and the same question is answered forty times. A ticket desk inside the HRMS has one advantage no generic tool (Freshdesk, Zoho Desk) has: **the ticket already knows who the employee is, their manager, their department, their payslip and their leave balance.** A "my salary is short" ticket can render the payslip and the LOP calculation inline.

### Schema

```sql
CREATE TABLE ticket_categories (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  name text NOT NULL,                       -- Payroll | Leave | Attendance | IT | Facilities
  parent_id uuid,
  assigned_role text, assigned_team_id uuid,        -- default routing
  sla_response_minutes int NOT NULL DEFAULT 480,
  sla_resolution_minutes int NOT NULL DEFAULT 2880,
  form_schema jsonb NOT NULL DEFAULT '[]',          -- reuses custom_field_definitions
  is_confidential boolean NOT NULL DEFAULT false,   -- see §1.3
  auto_close_after_days int NOT NULL DEFAULT 7,
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE tickets (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  ticket_number text NOT NULL,              -- HR-2841, per-tenant sequence
  category_id uuid NOT NULL,
  raised_by_user_id uuid NOT NULL,
  subject_employee_id uuid,                 -- usually the raiser; HR can raise on behalf
  title text NOT NULL, description text NOT NULL,
  custom jsonb NOT NULL DEFAULT '{}',       -- category form answers
  hrms_ref jsonb,                           -- {"type":"payslip","id":"..."} inline context
  priority text NOT NULL DEFAULT 'medium',  -- low|medium|high|urgent
  status text NOT NULL DEFAULT 'open',      -- open|assigned|in_progress|waiting_on_employee
                                            -- |resolved|closed|reopened|cancelled
  assigned_to_user_id uuid, assigned_team_id uuid,
  is_confidential boolean NOT NULL DEFAULT false,
  sla_response_due_at timestamptz, sla_resolution_due_at timestamptz,
  first_responded_at timestamptz, resolved_at timestamptz, closed_at timestamptz,
  sla_response_breached boolean NOT NULL DEFAULT false,
  sla_resolution_breached boolean NOT NULL DEFAULT false,
  reopen_count int NOT NULL DEFAULT 0,
  satisfaction_rating smallint, satisfaction_comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, ticket_number)
);
CREATE INDEX ON tickets (tenant_id, status, sla_resolution_due_at);
CREATE INDEX ON tickets (tenant_id, assigned_to_user_id, status);

CREATE TABLE ticket_messages (
  tenant_id uuid NOT NULL, id bigserial, ticket_id uuid NOT NULL,
  author_user_id uuid, author_type text NOT NULL,   -- employee|agent|system
  body text NOT NULL,
  is_internal_note boolean NOT NULL DEFAULT false,  -- agent-only, never shown to raiser
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE ticket_attachments (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL, message_id bigint,
  object_key text NOT NULL, file_name text NOT NULL,
  mime_type text, size_bytes bigint, scan_status text NOT NULL DEFAULT 'pending',
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE ticket_events (               -- append-only history
  tenant_id uuid NOT NULL, id bigserial, ticket_id uuid NOT NULL,
  event_type text NOT NULL,                -- created|assigned|status_changed|escalated
                                           -- |sla_breached|reopened|merged
  actor_user_id uuid, from_value jsonb, to_value jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE ticket_escalation_rules (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  category_id uuid, priority text,
  trigger text NOT NULL,                   -- response_breach|resolution_breach|no_activity
  after_minutes int NOT NULL,
  action text NOT NULL,                    -- notify|reassign|raise_priority
  target_role text, target_user_id uuid,
  PRIMARY KEY (tenant_id, id)
);
```

### 1.1 SLA handling

SLA due times are **computed at creation and stored**, not derived at read time — otherwise a category SLA change retroactively rewrites history, and breach reports become fiction.

Working-hours-aware: SLA clocks respect the tenant's shift calendar and holiday calendar (both already in the data model). A ticket raised at 6pm Friday is not breached by Monday morning because the clock did not run. This is the detail that decides whether SLA reporting is trusted or ignored.

The clock pauses in `waiting_on_employee` and resumes on reply. Pause intervals are recorded in `ticket_events` so a breach is always explainable.

A scheduled job evaluates due tickets, marks breaches, and applies `ticket_escalation_rules`. It is idempotent and re-runnable.

### 1.2 Routing

1. Category default (role or team)
2. Scope override — IT tickets from the Hyderabad office go to the Hyderabad IT queue (uses the same `tenant_setting_overrides` scoping as everything else)
3. Round-robin or least-loaded within the team
4. Manual reassignment, always recorded

Teams are a thin table (`support_teams`, `support_team_members`) rather than a reuse of departments — the payroll support team is not the payroll department.

### 1.3 Confidential categories — the part to get right

Grievance, harassment/POSH, whistleblower and medical categories **must not be visible to the employee's own manager, or to general HR staff**.

- `is_confidential` on the category propagates to the ticket at creation and cannot be removed afterwards.
- Confidential tickets are visible only to a named committee (`ticket_confidential_access`, an explicit user list per category), never via the normal `hr_admin` role.
- They are excluded from every list, search, dashboard count and export that the ticket owner is not on.
- Every read of a confidential ticket writes an `audit_event`, including reads by permitted committee members.
- Anonymous raising is supported per category: `raised_by_user_id` is stored encrypted and revealed only to the committee, or not at all where the tenant configures full anonymity.

Getting this wrong is not a bug, it is a harm. It is called out here because the generic ticket model above would otherwise leak these by default through manager scope.

### 1.4 Knowledge base

A small `kb_articles` table (tenant-scoped, category-linked, FTS-indexed) with article suggestions shown during ticket creation. Deflection is the cheapest support win available: *"How do I apply for leave?"* should never become a ticket. Ships with the helpdesk, not after it.

### 1.5 Configurability

Per `configurability.md`, the tenant owns all of it: categories and their hierarchy, per-category forms, SLA targets, working-hours basis, routing, escalation rules, confidentiality flags, auto-close windows, satisfaction survey on/off, and whether employees may raise tickets on behalf of others. `helpdesk.enabled` is a module toggle like any other.

---

## 2. Platform Support Desk (tenant → PEPL)

Lives in the **control plane**, on control-plane tables, under the control-plane role. Same state machine, different boundary.

```sql
-- control-plane schema, NOT tenant-scoped, NOT under app RLS
CREATE TABLE platform_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,                 -- which customer
  raised_by_user_id uuid NOT NULL, raised_by_email citext NOT NULL,
  category text NOT NULL,                  -- bug|billing|howto|data|feature|incident
  severity text NOT NULL,                  -- sev1..sev4
  subject text NOT NULL, description text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  assigned_to_agent_id uuid,
  plan_code text, mrr_paise bigint,        -- prioritisation context
  sla_response_due_at timestamptz, sla_resolution_due_at timestamptz,
  linked_issue_url text,                   -- the tracker
  diagnostic_bundle jsonb,                 -- version, tenant config version, request ids
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 2.1 Severity, tied to payroll reality

| Sev | Definition | Response |
|---|---|---|
| **Sev 1** | Payroll cannot be run or is wrong, on or near a pay date; or a suspected data-isolation issue | 1 hour, 24×7, paged |
| Sev 2 | A module is unusable; attendance not capturing | 4 business hours |
| Sev 3 | Degraded, workaround exists | 1 business day |
| Sev 4 | Question, enhancement | 3 business days |

Payroll dates are known per tenant, so severity can be **auto-escalated within a tenant's payroll window**. A Sev 3 on the 27th of the month is not a Sev 3.

### 2.2 Support access to tenant data — the rule

Our support staff must sometimes look inside a tenant to help. That capability is the largest standing risk to the isolation guarantee, so it is constrained:

- Access is **grant-based and time-boxed**: a tenant admin approves a support session (default 4 hours) from within their own settings, or an emergency break-glass path requires two-person approval on our side.
- Every session issues a distinct database role with the tenant context pinned; it is **never** an unset `app.tenant_id`.
- The full session is recorded: who, when, why, which ticket, which records were read.
- The tenant sees a permanent log of every support access in their own audit trail, and a banner while a session is live.
- Tier-3 fields (bank details, PAN, salary) remain masked to support unless separately and explicitly unmasked, per record, with a reason.

```sql
CREATE TABLE support_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL, ticket_id uuid,
  agent_id uuid NOT NULL,
  granted_by_user_id uuid,                 -- the tenant admin; null = break-glass
  break_glass boolean NOT NULL DEFAULT false,
  approver_2_agent_id uuid,                -- required when break_glass
  reason text NOT NULL,
  scope text NOT NULL DEFAULT 'read_only', -- read_only | read_write
  starts_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
```

"Support can log in as the customer" is a normal SaaS convenience and a serious liability in a payroll product. The grant model keeps the convenience and removes the liability.

---

## 3. Relationship to tasks

`tickets` and `tasks` (`field-sales-ops.md` §3) are deliberately separate tables. A task is assigned work with a due date; a ticket is a request with a requester, an SLA and a conversation. They share the unified inbox (`/inbox` returns `kind: approval | task | ticket`) and the same attachment pipeline, and nothing else.

Resisting the urge to unify them into a "work item" abstraction is the correct call: SLA pausing, confidentiality, satisfaction surveys and requester conversations are ticket concerns that would pollute the task model, and templates and dependency ordering are task concerns that would pollute tickets.

---

## 4. Build sequence

| Wave | Add |
|---|---|
| 6 | Tasks primitive |
| 6 | **Employee Helpdesk** — categories, tickets, SLA, routing, KB, confidential categories |
| 8 | **Platform Support Desk** + `support_access_grants` — with the control plane, before self-serve customers arrive |

The platform desk cannot slip past the control plane: the moment PEPL is publicly available, strangers hit problems inside their own tenants and we need a safe, audited way to look.
