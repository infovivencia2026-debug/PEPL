-- Employee helpdesk. See docs/architecture/helpdesk.md §1.
--
-- The confidentiality model is the part that must not be got wrong: a grievance
-- or POSH ticket must be invisible to the employee's own manager and to general
-- HR. That is a within-tenant boundary, so RLS on tenant_id alone cannot express
-- it — the policy below also reads app.user_id, which withTenant() already pins.

CREATE TABLE IF NOT EXISTS ticket_categories (
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  parent_id              uuid,
  assigned_role          text,
  sla_response_minutes   int NOT NULL DEFAULT 480,
  sla_resolution_minutes int NOT NULL DEFAULT 2880,
  is_confidential        boolean NOT NULL DEFAULT false,
  auto_close_after_days  int NOT NULL DEFAULT 7,
  status                 text NOT NULL DEFAULT 'active',
  PRIMARY KEY (tenant_id, id)
);

-- The named committee for a confidential category. Membership here — not the
-- hr_admin role — is what grants sight of a grievance.
CREATE TABLE IF NOT EXISTS ticket_confidential_access (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  category_id uuid NOT NULL,
  user_id     uuid NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, category_id, user_id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES ticket_categories (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS tickets (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_number        text NOT NULL,
  category_id          uuid NOT NULL,
  raised_by_user_id    uuid NOT NULL,
  subject_employee_id  uuid,
  title                text NOT NULL,
  description          text NOT NULL,
  priority             text NOT NULL DEFAULT 'medium',
  status               text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','assigned','in_progress','waiting_on_employee',
                                         'resolved','closed','reopened','cancelled')),
  assigned_to_user_id  uuid,
  is_confidential      boolean NOT NULL DEFAULT false,
  -- computed AT CREATION and stored: deriving at read time means a later change
  -- to the category SLA retroactively rewrites history and breach reports become
  -- fiction.
  sla_response_due_at   timestamptz,
  sla_resolution_due_at timestamptz,
  first_responded_at    timestamptz,
  resolved_at           timestamptz,
  paused_at             timestamptz,
  paused_minutes        int NOT NULL DEFAULT 0,
  sla_response_breached   boolean NOT NULL DEFAULT false,
  sla_resolution_breached boolean NOT NULL DEFAULT false,
  reopen_count          int NOT NULL DEFAULT 0,
  satisfaction_rating   smallint,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, ticket_number),
  FOREIGN KEY (tenant_id, category_id) REFERENCES ticket_categories (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS tickets_queue_idx
  ON tickets (tenant_id, status, sla_resolution_due_at);

CREATE TABLE IF NOT EXISTS ticket_messages (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               bigint GENERATED ALWAYS AS IDENTITY,
  ticket_id        uuid NOT NULL,
  author_user_id   uuid,
  author_type      text NOT NULL DEFAULT 'employee',
  body             text NOT NULL,
  is_internal_note boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ticket_events (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            bigint GENERATED ALWAYS AS IDENTITY,
  ticket_id     uuid NOT NULL,
  event_type    text NOT NULL,
  actor_user_id uuid,
  from_value    jsonb,
  to_value      jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id)
);

CREATE OR REPLACE FUNCTION current_app_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_categories','ticket_confidential_access','ticket_messages','ticket_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  EXECUTE format('REVOKE UPDATE, DELETE ON ticket_events FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tickets TO %I', app_role);
END $$;

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tickets;

-- Tenant isolation AND within-tenant confidentiality in one policy. A
-- confidential ticket is visible only to the person who raised it and to the
-- named committee for its category — never through the ordinary hr_admin role,
-- and never in a list, a count, a search or an export, because the rows simply
-- are not returned.
CREATE POLICY tenant_isolation ON tickets
  USING (
    tenant_id = current_tenant()
    AND (
      NOT is_confidential
      OR raised_by_user_id = current_app_user()
      OR EXISTS (
        SELECT 1 FROM ticket_confidential_access a
         WHERE a.tenant_id = tickets.tenant_id
           AND a.category_id = tickets.category_id
           AND a.user_id = current_app_user()
      )
    )
  )
  WITH CHECK (tenant_id = current_tenant());
