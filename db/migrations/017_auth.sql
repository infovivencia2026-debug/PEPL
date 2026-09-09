-- Authentication and role assignment.
--
-- Sessions are OPAQUE tokens stored server-side rather than self-contained JWTs:
-- revocation has to be immediate and total for a payroll product (an exit, a
-- compromised device, a support session ending), and a stateless token cannot
-- be withdrawn before it expires.

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS employee_id   uuid,
  ADD COLUMN IF NOT EXISTS mfa_secret    text,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS token_version int NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_roles (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id   uuid NOT NULL,
  role      text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, role),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_users (tenant_id, id)
);

-- Tenant-scoped custom roles. The permission model was always evaluated against
-- permission STRINGS, so this is a table plus an editor, not a rewrite.
CREATE TABLE IF NOT EXISTS custom_roles (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  permissions text[] NOT NULL DEFAULT '{}',
  data_scope  text NOT NULL DEFAULT 'self' CHECK (data_scope IN ('all','reports','self')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS sessions (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  -- only the HASH is stored: a database leak must not yield usable sessions
  token_hash     text NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  ip             inet,
  user_agent     text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_users (tenant_id, id)
);

-- Lookup by token hash has to work BEFORE a tenant is known, so it is a global
-- unique index; the row itself still carries tenant_id and is RLS-protected for
-- every subsequent access.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_idx ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (tenant_id, user_id, revoked_at);

-- Brute-force protection, per email and per IP.
CREATE TABLE IF NOT EXISTS login_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text NOT NULL,
  ip          inet,
  succeeded   boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_email_idx ON login_attempts (email, attempted_at DESC);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['user_roles','custom_roles','sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  EXECUTE format('GRANT SELECT, INSERT ON login_attempts TO %I', app_role);
END $$;
