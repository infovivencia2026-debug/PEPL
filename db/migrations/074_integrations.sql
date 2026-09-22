-- Integrations hub (blueprint C1): API keys, webhooks, connections.
--
-- An API key IS a user: it belongs to a service user with an ordinary role, so
-- every permission and scope rule applies unchanged and the audit trail names
-- it. A webhook is a subscription to the closed audit vocabulary, delivered
-- with an HMAC signature and retried with backoff; it carries ids, never PII.
-- A connection is a named, encrypted credential for an external system.

CREATE TABLE IF NOT EXISTS api_keys (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,                        -- the service user this key acts as
  name          text NOT NULL,
  prefix        text NOT NULL,                        -- first 12 chars, shown in lists
  key_hash      text NOT NULL,                        -- sha256 of the full key
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_by_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, prefix),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_users (tenant_id, id)
);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS is_service boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS webhooks (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  url           text NOT NULL,
  secret_ciphertext bytea NOT NULL,
  events        text[] NOT NULL,                      -- audit actions or prefixes: 'leave.*', 'payroll.run.locked'
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  last_audit_id bigint NOT NULL DEFAULT 0,            -- cursor into audit_events
  consecutive_failures int NOT NULL DEFAULT 0,
  created_by_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  webhook_id    uuid NOT NULL,
  audit_id      bigint NOT NULL,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts      int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status int,
  last_error    text,
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, webhook_id, audit_id),
  FOREIGN KEY (tenant_id, webhook_id) REFERENCES webhooks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (tenant_id, next_attempt_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS integration_connections (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('tally','zoho_books','razorpayx','google','microsoft','sms','biometric','esign','slack','teams','custom')),
  name          text NOT NULL,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- non-secret settings (base URL, company name, device ids)
  secret_ciphertext bytea,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','error')),
  last_checked_at timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, kind, name)
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys','webhooks','webhook_deliveries','integration_connections'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;

-- A bearer that starts with pk_ is an API key: a pre-tenant lookup by hash, like sessions.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY identity_lookup_owner ON api_keys TO %I USING (tenant_id = current_tenant() OR current_user = %L) WITH CHECK (tenant_id = current_tenant())', current_user, current_user);
END $$;
CREATE OR REPLACE FUNCTION auth_api_key_by_hash(p_hash text)
RETURNS TABLE(tenant_id uuid, id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT k.tenant_id, k.id, k.user_id FROM public.api_keys k
   WHERE k.key_hash = p_hash AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
$$;
REVOKE ALL ON FUNCTION auth_api_key_by_hash(text) FROM PUBLIC;
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION auth_api_key_by_hash(text) TO %I', app_role);
END $$;
