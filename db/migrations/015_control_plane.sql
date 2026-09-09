-- Control plane. See docs/architecture/platform-control-plane.md.
--
-- Everything ABOUT customers rather than INSIDE a customer. Its own schema, its
-- own role, cross-tenant BY DESIGN — which is exactly why it must not share a
-- boundary with the application plane. Mixing them means the isolation rule has
-- exceptions, and an exception is the thing that eventually leaks.

CREATE SCHEMA IF NOT EXISTS control_plane;

CREATE TABLE IF NOT EXISTS control_plane.plans (
  code                    text PRIMARY KEY,
  name                    text NOT NULL,
  base_price_paise        bigint NOT NULL DEFAULT 0,
  per_employee_price_paise bigint NOT NULL DEFAULT 0,
  features                jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                  text NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS control_plane.subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL UNIQUE,
  plan_code            text NOT NULL REFERENCES control_plane.plans(code),
  status               text NOT NULL DEFAULT 'trialing'
                       CHECK (status IN ('trialing','active','past_due','suspended','cancelled')),
  trial_ends_on        date,
  current_period_start date NOT NULL DEFAULT CURRENT_DATE,
  current_period_end   date NOT NULL DEFAULT (CURRENT_DATE + 30),
  feature_addons       jsonb NOT NULL DEFAULT '{}'::jsonb,
  limit_overrides      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Idempotent and RESUMABLE. Half-provisioned tenants are the most common early
-- SaaS support load: a failure at step 4 must not leave a tenant that can log in
-- but has no leave types.
CREATE TABLE IF NOT EXISTS control_plane.provisioning_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','failed','completed')),
  completed_steps text[] NOT NULL DEFAULT '{}',
  last_error      text,
  attempts        int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

-- Support access is the largest standing risk to the isolation guarantee, so it
-- is grant-based, time-boxed, reasoned, and mirrored into the tenant's own log.
CREATE TABLE IF NOT EXISTS control_plane.support_access_grants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  agent_id            uuid NOT NULL,
  granted_by_user_id  uuid,              -- the tenant admin; NULL = break-glass
  break_glass         boolean NOT NULL DEFAULT false,
  approver_2_agent_id uuid,              -- required when break_glass
  reason              text NOT NULL,
  scope               text NOT NULL DEFAULT 'read_only' CHECK (scope IN ('read_only','read_write')),
  starts_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  CHECK (NOT break_glass OR approver_2_agent_id IS NOT NULL),
  CHECK (break_glass OR granted_by_user_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS control_plane.platform_audit (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid,
  agent_id      uuid,
  action        text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

-- The application role can read NOTHING in the control plane. Entitlements reach
-- it only as a projection written by the control-plane role into the app schema.
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('REVOKE ALL ON SCHEMA control_plane FROM %I', app_role);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM %I', app_role);
END $$;

INSERT INTO control_plane.plans (code, name, base_price_paise, per_employee_price_paise, features, limits)
VALUES
  ('trial', 'Trial', 0, 0,
   '{"payroll":true,"helpdesk":true,"incentives":true}'::jsonb,
   '{"employees":25,"storage_gb":2}'::jsonb),
  ('starter', 'Starter', 200000, 5000,
   '{"payroll":false,"helpdesk":false,"incentives":false}'::jsonb,
   '{"employees":50,"storage_gb":5}'::jsonb),
  ('growth', 'Growth', 500000, 8000,
   '{"payroll":true,"helpdesk":false,"incentives":false}'::jsonb,
   '{"employees":200,"storage_gb":20}'::jsonb),
  ('professional', 'Professional', 1200000, 10000,
   '{"payroll":true,"helpdesk":true,"incentives":true}'::jsonb,
   '{"employees":1000,"storage_gb":100}'::jsonb)
ON CONFLICT (code) DO NOTHING;
