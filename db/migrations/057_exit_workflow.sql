-- The exit workflow around the money.
--
-- Full-and-final settlement existed (employee_separations); everything a
-- person and their manager do before it did not: the employee's own
-- resignation, the notice-period negotiation, the clearance checklist that
-- gates sign-off, the exit interview, and the relieving / experience letter.

-- A resignation is a request the employee raises; HR accepts it into a
-- separation (or the manager tries to retain them). Kept separately from
-- employee_separations because a resignation can be withdrawn before HR acts.
CREATE TABLE IF NOT EXISTS resignations (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id          uuid NOT NULL,
  submitted_on         date NOT NULL DEFAULT CURRENT_DATE,
  requested_last_day   date NOT NULL,
  reason               text NOT NULL,
  reason_category      text NOT NULL DEFAULT 'other'
        CHECK (reason_category IN ('better_opportunity','compensation','relocation','higher_studies','personal','health','manager','culture','other')),
  status               text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','withdrawn','accepted','declined')),
  separation_id        uuid,
  decided_by_user_id   uuid,
  decided_at           timestamptz,
  decision_note        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
-- one live resignation per person
CREATE UNIQUE INDEX IF NOT EXISTS resignations_open_idx ON resignations (tenant_id, employee_id) WHERE status = 'submitted';

-- Clearance: each department signs off. Rows are created from the exit
-- checklist template (tasks) AND recorded here in the fixed set every company
-- needs, so the F&F cannot be released with a laptop still out.
CREATE TABLE IF NOT EXISTS exit_clearances (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  separation_id        uuid NOT NULL,
  area                 text NOT NULL CHECK (area IN ('manager','it','finance','admin','hr')),
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cleared','recovery')),
  note                 text,
  recovery_paise       bigint NOT NULL DEFAULT 0 CHECK (recovery_paise >= 0),
  cleared_by_user_id   uuid,
  cleared_at           timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, separation_id, area),
  FOREIGN KEY (tenant_id, separation_id) REFERENCES employee_separations (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exit_interviews (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  separation_id        uuid NOT NULL,
  conducted_by_user_id uuid,
  conducted_on         date,
  would_rejoin         boolean,
  would_recommend      boolean,
  ratings              jsonb NOT NULL DEFAULT '{}'::jsonb,     -- { manager: 1-5, growth: 1-5, pay: 1-5, culture: 1-5, worklife: 1-5 }
  primary_reason       text,
  feedback             text,
  confidential         boolean NOT NULL DEFAULT true,          -- visible to HR only, never the manager
  PRIMARY KEY (tenant_id, separation_id),
  FOREIGN KEY (tenant_id, separation_id) REFERENCES employee_separations (tenant_id, id) ON DELETE CASCADE
);

-- Who did what on the separation: HR sign-off, letters issued.
ALTER TABLE employee_separations ADD COLUMN IF NOT EXISTS resignation_id uuid;
ALTER TABLE employee_separations ADD COLUMN IF NOT EXISTS cleared_at timestamptz;
ALTER TABLE employee_separations ADD COLUMN IF NOT EXISTS cleared_by_user_id uuid;
ALTER TABLE employee_separations ADD COLUMN IF NOT EXISTS relieving_letter_document_id uuid;
ALTER TABLE employee_separations ADD COLUMN IF NOT EXISTS knowledge_transfer_to uuid;
ALTER TABLE employee_separations ADD COLUMN IF NOT EXISTS knowledge_transfer_note text;

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['resignations','exit_clearances','exit_interviews'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
