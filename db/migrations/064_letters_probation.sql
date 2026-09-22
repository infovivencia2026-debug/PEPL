-- Letters engine and probation reviews (blueprint A5).
--
-- A letter template is a body with {{merge.fields}}; issuing one resolves the
-- fields from the employee's record, renders a PDF, files it under the
-- person's documents and records the issue with a reference number. HR edits
-- templates per company; the defaults are seeded on first use.

CREATE TABLE IF NOT EXISTS letter_templates (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  code          text NOT NULL,                       -- appointment | confirmation | increment | experience | address_proof | salary_certificate | warning | custom-*
  name          text NOT NULL,
  title         text NOT NULL,                       -- printed heading
  body          text NOT NULL,                       -- paragraphs separated by blank lines; {{field}} merges
  category      text NOT NULL DEFAULT 'other',       -- document category the issued letter files under
  confidential  boolean NOT NULL DEFAULT true,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS issued_letters (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL,
  template_id     uuid NOT NULL,
  code            text NOT NULL,
  reference_no    text NOT NULL,
  document_id     uuid NOT NULL,
  merge_values    jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_by_user_id uuid,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, reference_no),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES letter_templates (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS issued_letters_employee_idx ON issued_letters (tenant_id, employee_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS letter_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  year      int  NOT NULL,
  last_no   int  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year)
);

-- A probation review is opened by the nightly job ahead of probation_end and
-- decided by the manager or HR: confirm (letter issued, employment_type
-- permanent), extend (new end date), or separate (HR takes it to exit).
CREATE TABLE IF NOT EXISTS probation_reviews (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL,
  probation_end   date NOT NULL,
  reviewer_employee_id uuid,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','extended','separated')),
  rating          int CHECK (rating BETWEEN 1 AND 5),
  remarks         text,
  extended_to     date,
  decided_by_user_id uuid,
  decided_at      timestamptz,
  letter_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS probation_reviews_one_open_idx ON probation_reviews (tenant_id, employee_id) WHERE status = 'pending';

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['letter_templates','issued_letters','letter_counters','probation_reviews'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  EXECUTE format('REVOKE UPDATE, DELETE ON issued_letters FROM %I', app_role);   -- an issued letter is a record
END $$;
