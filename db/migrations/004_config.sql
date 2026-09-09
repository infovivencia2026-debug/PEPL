-- Configuration layer: the five-layer model from docs/architecture/configurability.md.
--
--   1 capability     registry, in code
--   2 release flag   platform-owned            (later wave)
--   3 entitlement    tenant_entitlements       written by the control plane only
--   4 tenant setting tenant_settings           the customer's control
--   5 scope override tenant_setting_overrides  the customer's control
--
-- Layers 4 and 5 are tenant-owned and therefore tenant-isolated exactly like
-- employee data. A change by one company can never affect another.

-- Layer 3. Projection of the control-plane subscription; app role has SELECT only.
CREATE TABLE IF NOT EXISTS tenant_entitlements (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id),
  plan_code   text NOT NULL,
  features    jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits      jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from  date NOT NULL DEFAULT CURRENT_DATE,
  valid_until date NOT NULL DEFAULT (CURRENT_DATE + 365),
  status      text NOT NULL DEFAULT 'active',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Layer 4. Absent row = registry default. effective_from NULL means immediate;
-- it is REQUIRED for any key declaring affects:['payroll'] (enforced in the
-- service, because the registry that knows which keys those are lives in code).
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  key            text NOT NULL,
  value          jsonb NOT NULL,
  effective_from date,
  set_by_user_id uuid,
  reason         text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT (PG15+) lets effective_from stay nullable — NULL means
  -- "applies immediately" — while still giving ON CONFLICT a unique target.
  -- A plain PRIMARY KEY would force NOT NULL and destroy that semantic.
  UNIQUE NULLS NOT DISTINCT (tenant_id, key, effective_from)
);

-- Layer 5. Lower priority wins, so conflicts resolve deterministically.
CREATE TABLE IF NOT EXISTS tenant_setting_overrides (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  key            text NOT NULL,
  scope_type     text NOT NULL,
  scope_id       uuid NOT NULL,
  value          jsonb NOT NULL,
  effective_from date,
  priority       int NOT NULL DEFAULT 100,
  set_by_user_id uuid,
  reason         text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, key, scope_type, scope_id, effective_from)
);

-- Cache invalidation. Bumped in the SAME transaction as any config write, so a
-- new version can never be observed alongside stale values.
CREATE TABLE IF NOT EXISTS tenant_config_versions (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id),
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only. Answers "payroll behaved differently in September - what changed?"
CREATE TABLE IF NOT EXISTS config_change_log (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  id             bigint GENERATED ALWAYS AS IDENTITY,
  key            text NOT NULL,
  scope_type     text,
  scope_id       uuid,
  old_value      jsonb,
  new_value      jsonb,
  effective_from date,
  actor_user_id  uuid,
  actor_type     text NOT NULL DEFAULT 'user',
  reason         text,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS config_change_log_key_idx
  ON config_change_log (tenant_id, key, changed_at DESC);

-- RLS on every one of them, same regime as employee data.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_entitlements', 'tenant_settings', 'tenant_setting_overrides',
    'tenant_config_versions', 'config_change_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;

-- The app role never writes entitlements: a bug in the application must not be
-- able to grant a tenant a module they have not paid for.
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_settings, tenant_setting_overrides, tenant_config_versions TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON config_change_log TO %I', app_role);
  EXECUTE format('GRANT SELECT ON tenant_entitlements TO %I', app_role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON tenant_entitlements FROM %I', app_role);
  -- config_change_log is append-only: no rewriting history.
  EXECUTE format('REVOKE UPDATE, DELETE ON config_change_log FROM %I', app_role);
END $$;
