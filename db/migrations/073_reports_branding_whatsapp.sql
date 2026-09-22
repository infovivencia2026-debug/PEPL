-- Blueprint B6: generic work reports, per-tenant branding, WhatsApp channel.
--
-- Work reports are the vertical-without-forking pattern: a site DPR, a
-- trainer's session log and a sales visit report are ONE table with
-- template-defined fields. Branding is what a customer sees on the login
-- page, the payslip and every email. WhatsApp is a notification CHANNEL like
-- email: opt-in per person, provider per company, delivered by a job.

CREATE TABLE IF NOT EXISTS report_templates (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  name        text NOT NULL,
  frequency   text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily','per_visit','weekly','ad_hoc')),
  fields      jsonb NOT NULL,                       -- [{ key, label, type: text|number|date|choice|photo|geo|boolean, required, options?[] }]
  applies_to  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { departments: [], designations: [] } ; {} = everyone
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS work_reports (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  report_date date NOT NULL,
  project_id  uuid,
  values      jsonb NOT NULL,
  geo_lat     double precision, geo_lng double precision,
  photo_document_ids uuid[] NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','reviewed','returned')),
  review_note text,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES report_templates (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS work_reports_employee_idx ON work_reports (tenant_id, employee_id, report_date DESC);
CREATE INDEX IF NOT EXISTS work_reports_template_idx ON work_reports (tenant_id, template_id, report_date DESC);

CREATE TABLE IF NOT EXISTS tenant_branding (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  product_name    text,                              -- what the app calls itself for this company (white-label)
  logo_document_id uuid,
  primary_color   text CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9a-fA-F]{6}$'),
  accent_color    text CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-fA-F]{6}$'),
  payslip_header  text,
  payslip_footer  text,
  email_footer    text,
  custom_domain   text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_branding_domain_idx ON tenant_branding (lower(custom_domain)) WHERE custom_domain IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_providers (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  provider    text NOT NULL CHECK (provider IN ('meta_cloud','generic_webhook')),
  endpoint    text NOT NULL,                         -- meta: https://graph.facebook.com/v19.0/<phone_number_id>/messages ; generic: any URL
  from_number text,
  secret_ciphertext bytea,                           -- bearer token / API key, encrypted with the mail master key
  templates   jsonb NOT NULL DEFAULT '{}'::jsonb,    -- { event_type: template_name } for providers that require approved templates
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id)
);

CREATE TABLE IF NOT EXISTS user_whatsapp (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL,
  phone_e164  text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  opted_in_at timestamptz NOT NULL DEFAULT now(),
  opted_out_at timestamptz,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_users (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS whatsapp_sent_at timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS whatsapp_attempts int NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS whatsapp_error text;

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['report_templates','work_reports','tenant_branding','whatsapp_providers','user_whatsapp'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;

-- The login page needs a company's branding before anyone is signed in: a
-- narrow owner-run lookup by custom domain, like auth_user_by_email.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY identity_lookup_owner ON tenant_branding TO %I USING (tenant_id = current_tenant() OR current_user = %L) WITH CHECK (tenant_id = current_tenant())', current_user, current_user);
END $$;
CREATE OR REPLACE FUNCTION branding_by_domain(p_domain text)
RETURNS TABLE(tenant_id uuid, product_name text, primary_color text, accent_color text, logo_document_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT b.tenant_id, b.product_name, b.primary_color, b.accent_color, b.logo_document_id FROM public.tenant_branding b WHERE lower(b.custom_domain) = lower(p_domain)
$$;
REVOKE ALL ON FUNCTION branding_by_domain(text) FROM PUBLIC;
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION branding_by_domain(text) TO %I', app_role);
END $$;
