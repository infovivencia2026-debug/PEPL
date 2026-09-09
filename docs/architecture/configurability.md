# PEPL — Configuration architecture

> **Requirement:** a tenant administrator can enable, disable and edit every feature — **for their own company only**, never affecting any other tenant.

This is the most architecturally consequential requirement in PEPL. It is not a settings page. Done casually it produces a system where no two customers behave alike, no bug is reproducible, and payroll silently changes under a locked run. Done properly it is the product's main defensibility.

---

## 1. The five layers (do not conflate them)

The standard failure in configurable SaaS is treating "feature on/off" as one concept. It is five, with different owners, lifetimes and failure modes.

| # | Layer | Owner | Question it answers | Lifetime | Tenant can edit? |
|---|---|---|---|---|---|
| 1 | **Capability** | Engineering | Does this code exist and is it registered? | Permanent | No |
| 2 | **Release flag** | Engineering | Is it safe to execute right now? (rollout, kill switch) | Weeks | No |
| 3 | **Entitlement** | Commercial / billing | Has this tenant paid for it, and up to what limit? | Plan lifetime | No |
| 4 | **Tenant setting** | **Tenant admin** | Do we want it, and configured how? | Forever | **Yes** |
| 5 | **Scoped override** | **Tenant admin** | …differently for this department / location / grade? | Forever | **Yes** |

Layers 1–3 are platform-owned. Layers 4–5 are the tenant's. The requirement "tenant admin can edit every feature" means **layers 4 and 5 are exhaustive** — every behaviour the product exposes has a tenant-editable setting — while layers 1–3 remain the boundary the tenant cannot cross.

### Resolution: AND, most restrictive wins

```
enabled(feature, tenant, scope) =
      capability_registered(feature)          -- code exists
  AND release_flag_on(feature, tenant)        -- platform kill switch
  AND entitled(feature, tenant)               -- they bought it
  AND tenant_setting_on(feature, tenant)      -- they turned it on
  AND scope_override_on(feature, scope)       -- for this dept/location/grade
```

**A tenant setting can never widen an entitlement.** An admin toggling `payroll.enabled = true` on a plan without payroll changes nothing; the API returns `ENTITLEMENT_REQUIRED` with an upgrade path. This one-directional rule is what makes "the tenant can edit everything" commercially safe.

**A release flag can always close.** Engineering retains a kill switch above every tenant's wishes — necessary when a payroll defect is found mid-cycle across many tenants.

---

## 2. Tenant isolation of configuration

Every value in layers 4 and 5 lives in a `tenant_id`-scoped table under the same RLS regime as employee data (`tenancy-security.md` §1):

```sql
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_settings
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

Consequences, stated as invariants and covered by the cross-tenant test suite:

- There is **no global mutable setting** a tenant admin can reach. Anything global (statutory rates, PT slabs) is platform-owned reference data, exposed read-only.
- A config read with no tenant context returns **zero rows**, and the resolver treats a missing value as the registry default — never as another tenant's value.
- The config cache is keyed by `tenant_id`; a cache-key bug is the most plausible route to a cross-tenant config leak, so the key is constructed in exactly one function and asserted in tests.
- Config export/import (tenant cloning) is a control-plane operation that writes to a target tenant explicitly; it never copies by ambient context.

---

## 3. The registry: definitions in code, values in the database

Config **definitions** ship with the application as a typed registry. Config **values** live per tenant in Postgres.

Why definitions are not rows: a definition needs a type, a default, validation, a dependency list, a risk class, help text, and a migration when its shape changes. In code these are reviewable, testable and versioned with the feature they govern. As rows they drift from the code that reads them — the single most common cause of "this setting does nothing".

```ts
// modules/leave/config.ts
export const leaveConfig = defineConfig('leave', {
  enabled: flag({
    default: true,
    risk: 'high',                 // module-level toggle
    dependsOn: [],
    disableEffect: 'soft',        // hide + stop accrual; retain all data
  }),
  sandwich_holidays: bool({
    default: false,
    label: 'Count holidays falling inside a leave as leave',
    affects: ['payroll'],         // => effective-dated, period-guarded
  }),
  allow_negative_balance: bool({ default: false, affects: ['payroll'] }),
  min_application_notice_days: int({ default: 0, min: 0, max: 90 }),
  max_backdated_days: int({ default: 30, min: 0, max: 365 }),
  approval_chain: enumOf(['manager', 'manager_then_hr', 'hr_only'], {
    default: 'manager',
    scopable: ['department', 'location', 'grade'],   // layer 5 eligible
  }),
  encashment: bool({ default: false, affects: ['payroll'], entitlement: 'payroll' }),
});
```

Each definition declares:

| Property | Purpose |
|---|---|
| `type` + validation | rejected at write, not discovered at read |
| `default` | the behaviour of a tenant that has configured nothing |
| `risk` | `low` / `high` — high-risk changes require confirmation and reason |
| `entitlement` | the entitlement key that must be present for this setting to have effect |
| `dependsOn` | other features that must be enabled (see §5) |
| `affects: ['payroll']` | forces effective-dating and open-period guards (§6) |
| `scopable` | which override dimensions layer 5 permits |
| `disableEffect` | `soft` (hide, retain) or `blocked_if_data` — never silent deletion |

The registry is the **single source of truth for the admin UI**: the settings screens are generated from it, so a new setting cannot ship without a label, a default, a risk class and a help string. That is deliberate friction.

---

## 4. Schema

```sql
-- Layer 3: what the tenant bought. Written by the control plane only.
CREATE TABLE tenant_entitlements (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id),
  plan_code  text NOT NULL,
  features   jsonb NOT NULL,     -- {"payroll":true,"ats":false,"ai_copilot":false}
  limits     jsonb NOT NULL,     -- {"employees":500,"storage_gb":20,"api_rpm":600}
  valid_from date NOT NULL, valid_until date NOT NULL,
  status     text NOT NULL DEFAULT 'active',   -- trial|active|past_due|suspended
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- app_user holds SELECT only. Writes come from the control-plane role.

-- Layer 4: tenant-owned settings. One row per set key; absent = registry default.
CREATE TABLE tenant_settings (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key       text NOT NULL,            -- 'leave.sandwich_holidays'
  value     jsonb NOT NULL,
  effective_from date,                -- NULL = immediate; required when affects payroll
  set_by_user_id uuid NOT NULL,
  reason    text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key, effective_from)
);

-- Layer 5: scoped overrides within the tenant.
CREATE TABLE tenant_setting_overrides (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  key         text NOT NULL,
  scope_type  text NOT NULL,          -- department|location|grade|employment_type
  scope_id    uuid NOT NULL,
  value       jsonb NOT NULL,
  effective_from date,
  priority    int NOT NULL DEFAULT 100,   -- lower wins; deterministic conflicts
  set_by_user_id uuid NOT NULL, reason text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key, scope_type, scope_id, effective_from)
);

-- Cache-invalidation counter. Bumped by any write above.
CREATE TABLE tenant_config_versions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  version   bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every config change, forever. Separate from audit_events for retention + query shape.
CREATE TABLE config_change_log (
  tenant_id uuid NOT NULL, id bigserial,
  key text NOT NULL, scope_type text, scope_id uuid,
  old_value jsonb, new_value jsonb,
  effective_from date,
  actor_user_id uuid NOT NULL, actor_type text NOT NULL,  -- user|support|system
  reason text, request_id uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```

`config_change_log` is append-only and is the answer to *"payroll behaved differently in September — what changed?"* It is queried alongside `payroll_runs.locked_at` during any dispute.

---

## 5. Dependencies and safe disabling

Features form a directed graph. Turning one off must not silently break another.

```
payroll ──requires──► attendance ──requires──► shifts
   │                      │
   └──requires──► leave ──┘
performance ──requires──► employees
expenses ──requires──► approvals
```

Rules enforced by the config service, not by the UI:

1. **Enabling** a feature auto-enables its dependencies, and says so in the confirmation: *"Enabling Payroll will also enable Attendance and Leave."*
2. **Disabling** a feature with dependents is refused with the list: *"Attendance cannot be disabled while Payroll is enabled."*
3. **Disabling is always soft.** The module disappears from navigation and its jobs stop; its data is retained and its tables stay readable to platform support and to re-enablement. `disableEffect: 'blocked_if_data'` is used where even a soft disable would be misleading — you cannot disable Payroll while an unlocked run exists.
4. **Re-enabling** restores the prior settings, not the defaults. The tenant's previous configuration is still in `tenant_settings`; nothing is deleted on disable.
5. **Destructive changes get a preview.** Changing a leave policy's accrual method shows *"This affects 312 employees; balances will be recalculated from 1 Oct. Historical ledger entries are unchanged."* before it commits.

---

## 6. Configuration and time — the payroll guard

A setting marked `affects: ['payroll']` cannot take effect retroactively. This is the rule that keeps `payroll.md` honest.

- Such settings **require `effective_from`**, and the UI defaults it to the start of the next payroll period.
- A change with `effective_from` inside an **open** payroll period whose inputs are already frozen is **rejected**: `CONFIG_LOCKED_PERIOD`. The admin is offered the next period instead.
- A change can never target a **closed or locked** period. There is no override, not even for platform support — correcting a locked run is a payroll revision (`payroll.md` §3), which is auditable, and not a quiet config edit, which is not.
- The resolver used by the payroll freeze is the **as-of** resolver: `resolveConfig(tenantId, { asOf: period.end })`, and the resolved config snapshot is stored on the run. A locked run therefore reproduces exactly even after the tenant reconfigures everything.

```sql
ALTER TABLE payroll_runs ADD COLUMN config_snapshot jsonb NOT NULL;
```

This mirrors the bitemporal treatment of employee facts: **configuration is a fact about the company that changes over time**, and payroll must read it as of the period, not as of now.

---

## 7. Resolution and caching

```ts
interface ResolvedConfig {
  version: bigint;
  isEnabled(feature: string, scope?: Scope): boolean;
  get<T>(key: string, scope?: Scope): T;
  limit(name: string): number;
}

// Resolved ONCE per request/job, never per call site.
const cfg = await configService.resolve(tenantId, { asOf: today, scope });
```

Resolution order per key: **scoped override (lowest `priority` wins) → tenant setting → registry default**, then gated by entitlement and release flag.

Caching:
- Per-process LRU keyed `${tenantId}:${configVersion}`, plus Redis for cross-process sharing.
- Any write bumps `tenant_config_versions.version` **in the same transaction as the write**, so a new version can never be observed with stale values.
- Cache entries are never invalidated by deletion, only superseded by a new version key — which removes a whole class of thundering-herd and partial-invalidation bugs.
- Target: config resolution adds < 1 ms to a request, with zero database round-trips on a cache hit.

**Anti-pattern, explicitly banned:** calling `isEnabled()` inside a loop over employees, each hitting the store. Payroll iterates 500 employees; config is resolved once before the loop.

---

## 8. Risk classes — what a tenant admin may *not* edit

"Every feature" means every product behaviour. It does not mean every value in the database, and the distinction has to be explicit or a well-meaning admin will cause a compliance incident.

### 8.1 Tenant control charter

The customer has **full control over how PEPL behaves for their company**. Concretely, a tenant administrator can self-serve, without contacting us and without a deployment:

- **Modules** — enable or disable any module they hold an entitlement for
- **Org model** — departments, grades, designations, locations, legal-entity naming, employee-number format
- **People** — custom fields on any entity, sections, required-ness, validation, visibility per role
- **Attendance** — which capture methods are allowed, geofence radius, shifts, grace, OT rules, regularization window, weekly-off patterns, holiday calendars per location
- **Leave** — create any leave type, versioned policies, accrual, carry-forward, encashment, sandwich rules, probation restrictions, per-scope variation
- **Payroll** — salary structures and components, formulas within components, pay calendar, LOP basis, rounding policy, validation thresholds, payslip layout, bank formats, statutory elections
- **Approvals** — chain per module, per department/location/grade, delegation, escalation, SLA
- **Roles** — create custom roles and edit the permission matrix down to individual actions
- **Documents** — letter templates with variables, versioned, per document type
- **Notifications** — the full event × channel matrix
- **Branding** — logo, colours, sender identity, payslip and letter headers
- **Data** — export everything they own, at any time, without asking us

### 8.2 The two boundaries, and why they protect the customer

| Class | Examples | Editable by tenant |
|---|---|---|
| `tenant_editable` | everything in the charter above | **Yes**, self-service |
| `statutory_default` | PF rate, EPS split, ESI threshold, PT slabs, income-tax slabs | **Yes, by explicit override** — see below |
| `entitlement_bound` | modules and limits not on their plan | Requires a plan change, not a toggle |
| `platform_only` | capability registry, release flags, other tenants' anything, encryption and isolation settings | No |

**Statutory rates ship as correct, current defaults that we maintain.** A tenant who needs to deviate — an unusual PF arrangement, a state rule we have not yet published, a rate change effective before our reference data is updated — can override it:

```sql
CREATE TABLE tenant_statutory_overrides (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  key text NOT NULL,                     -- pf_employee_rate, esi_gross_threshold_paise, ...
  value jsonb NOT NULL,
  effective_from date NOT NULL, effective_to date,
  acknowledged_by_user_id uuid NOT NULL,  -- named person accepting responsibility
  acknowledgement_text text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```

The override is available in the product, requires a typed acknowledgement recording that the tenant takes responsibility for the deviation, is effective-dated like every other payroll-affecting setting, appears permanently in the change log, and is surfaced on every payroll run that used it (*"3 statutory overrides applied"*). Nothing is blocked; everything is recorded.

This is a boundary that protects the customer rather than restricting them: the default is compliant so the 99% who never touch it stay compliant, and the 1% who must deviate can, with a defensible record of who decided and why.

The `entitlement_bound` line is the only genuine "no", and it is commercial, not technical: a toggle cannot grant a module the tenant has not purchased. The API says so explicitly with an upgrade path rather than failing silently.

`support_assisted` operations — reopening a closed attendance period, forcing a config change into a frozen payroll period, bulk data erasure — remain available to the tenant through a request flow rather than a raw toggle, because each one can destroy the audit trail the customer will later need. They are permitted; they are not one click.

---

## 9. What "edit every feature" additionally requires

The tenant-control requirement pulls three things into scope that a minimal build would have deferred:

| Previously deferred | Now required | Shape |
|---|---|---|
| Custom roles | **In** | Role = a named set of permission strings, tenant-scoped. The permission model in `api-boundaries.md` §2 already supports it; this makes the table tenant-scoped and adds an editor UI. |
| Approval chain configuration | **In (config, not builder)** | Per module, per scope, chains are chosen and ordered from a fixed step vocabulary (`manager`, `dept_head`, `hr`, `finance`, `named_user`). **Not** a drag-and-drop canvas with conditions and formulas — that stays deferred. |
| Custom fields | **In** | Definitions in `custom_field_definitions` (tenant-scoped), values in a `custom` JSONB column on the owning entity, validated against the definition on write, indexed with expression indexes where filtered. |

```sql
CREATE TABLE custom_field_definitions (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,        -- employee|leave_request|asset
  key text NOT NULL,
  label text NOT NULL,
  data_type text NOT NULL,          -- text|number|date|select|multiselect|boolean|file|employee
  options jsonb, required boolean NOT NULL DEFAULT false,
  validation jsonb, risk_tier smallint NOT NULL DEFAULT 2,
  section text, display_order int,
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, entity_type, key)
);
```

JSONB with a definitions table, not EAV: it keeps one row per employee, supports validation and typed reads, and indexes what actually gets filtered — without the join explosion EAV produces on a 500-employee list view.

What stays deferred, and why the deferral survives this requirement: **a general workflow/formula engine**. Configuring *which approval chain* is a bounded choice; configuring *arbitrary conditional logic with computed variables* is a programming language, and shipping one before observing 20 real tenants' needs produces the wrong language.

---

## 10. The admin surface

Generated from the registry, so it cannot drift from behaviour.

```
Settings
├── Modules            master on/off per module, with dependency warnings
├── People             custom fields, employee-number format, probation defaults
├── Attendance         capture methods, geofence, shifts, grace, OT, regularization window
├── Leave              types, policies (versioned), accrual, encashment, chains
├── Payroll            structures, components, pay calendar, statutory elections,
│                      validation thresholds   [statutory rates shown read-only]
├── Approvals          chain per module, per scope, delegation, escalation
├── Roles              custom roles, permission matrix
├── Documents          letter templates, retention
├── Notifications      channel + event matrix
├── Branding           logo, colours, sender name, payslip header
└── Change log         every config change, who, when, why, effective when
```

Each setting row shows: current value, **whether it differs from the default**, who last changed it and when, its effective date if pending, and a "reset to default" action. A "show only changed" filter is the first thing support asks for when a tenant reports odd behaviour — it turns "what have you configured?" from an interview into a URL.

High-risk changes (module disable, approval chain, anything `affects: payroll`) require a typed confirmation and a reason, and emit both a `config_change_log` row and an `audit_event`.

---

## 11. Testing a configurable system

Configurability multiplies the test matrix; the answer is to test the *resolver* exhaustively and the *features* against a small set of canonical profiles.

1. **Resolver unit tests** — every precedence combination: entitlement off + setting on; release flag off + setting on; two overlapping scope overrides at different priorities; effective-dated value before/after its date; missing value falling back to default.
2. **Canonical tenant profiles** — three fixtures the whole integration suite runs against:
   - `minimal`: attendance + leave only, single location, no payroll
   - `standard`: the defaults, payroll on, one state
   - `maximal`: every feature on, scoped overrides on every scopable key, custom fields, custom roles
   Payroll golden files run under `standard` and `maximal`.
3. **Registry invariants (CI)** — every definition has a label, default, risk class and help text; every `affects: payroll` key is effective-dateable; every `dependsOn` target exists; the dependency graph is acyclic; no key is read in code without a registry entry (lint rule on `cfg.get`).
4. **Isolation** — the cross-tenant suite includes config: tenant A's settings, overrides, custom fields and roles are invisible and unwritable from tenant B, and A's cache never serves B.
5. **Config fuzz** — randomised valid configurations run against the payroll golden set; the run must either produce the expected output or fail with a validation error, never silently differ.

---

## 12. Cost, stated plainly

Every setting is permanent surface area: a UI row, a migration, a test axis, a support answer, and a documentation line. A hundred settings is a real product; a thousand is a system nobody — including us — can reason about.

The discipline that keeps this from decaying:

- A new setting requires a **named customer request or a legal requirement**. "Someone might want it" is not sufficient; the default should be the opinionated choice.
- Every setting ships with a default that is correct for the ICP, so a tenant that configures nothing has a working payroll.
- Settings are reviewed quarterly; one that no tenant has ever changed becomes a constant.
- The `maximal` fixture must stay green. If a combination is untestable, it should not be configurable.
