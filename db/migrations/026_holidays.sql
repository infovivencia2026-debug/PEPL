-- The company holiday calendar.
--
-- Leave day counting was a client-supplied number until now: the browser sent
-- totalDays and the server believed it. That is both a correctness problem (a
-- request for a week could claim half a day) and the reason
-- leave.sandwich_holidays had to be removed — a rule about holidays falling
-- inside a leave cannot be applied without knowing which days are holidays.
--
-- Holidays are per company and optionally per location, because a national
-- holiday list is not the same in every state of India, which is the whole
-- reason the location scope exists elsewhere in the config layer.

CREATE TABLE IF NOT EXISTS holidays (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  holiday_on  date NOT NULL,
  name        text NOT NULL,
  -- NULL means the whole company. A value restricts it to that location.
  location    text,
  -- Optional holidays let an employee choose from a pool; they are listed but
  -- never auto-deducted, so counting treats them as working days.
  is_optional boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

-- One entry per date per location. NULLS NOT DISTINCT so a second company-wide
-- holiday on the same date is rejected rather than silently duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS holiday_date_idx
  ON holidays (tenant_id, holiday_on, location) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS holiday_range_idx ON holidays (tenant_id, holiday_on);

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE holidays ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE holidays FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON holidays';
  EXECUTE 'CREATE POLICY tenant_isolation ON holidays
             USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON holidays TO %I', app_role);
END $$;
