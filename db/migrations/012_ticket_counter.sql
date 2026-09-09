-- Ticket numbers must NOT be derived from MAX() over the tickets table.
--
-- The confidentiality policy filters tickets by the current user, so a
-- confidential ticket is invisible to most callers — and a MAX() that cannot see
-- it hands out a number already in use. The unique constraint would catch it,
-- but only as an error a user sees.
--
-- A per-tenant counter is visible to everyone in the tenant (a sequence number
-- reveals nothing) and is therefore immune to that filtering.
CREATE TABLE IF NOT EXISTS ticket_counters (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id),
  next_number int NOT NULL DEFAULT 1
);

ALTER TABLE ticket_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_counters FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ticket_counters;
CREATE POLICY tenant_isolation ON ticket_counters
  USING      (tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ticket_counters TO %I', app_role);
END $$;
