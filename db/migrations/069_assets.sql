-- Assets (blueprint B2): what the company hands people and wants back.
-- Catalogue → items (serialised) → assignments (issue / return) with condition
-- notes; software licences are seats without a serial. Exit clearance for IT
-- and admin refuses to sign while the leaver still holds an item.

CREATE TABLE IF NOT EXISTS asset_categories (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL,                          -- LAPTOP, PHONE, SIM, ID_CARD, UNIFORM, PPE, TOOL, VEHICLE, LICENCE, OTHER
  name        text NOT NULL,
  clearance_area text NOT NULL DEFAULT 'it' CHECK (clearance_area IN ('it','admin','finance','manager')),
  returnable  boolean NOT NULL DEFAULT true,          -- uniforms and PPE issued to keep are not
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS assets (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  category_id   uuid NOT NULL,
  tag           text NOT NULL,                        -- asset tag / seat label, unique per company
  name          text NOT NULL,                        -- 'Dell Latitude 5440', 'Adobe CC seat'
  serial_no     text,
  purchased_on  date,
  cost_paise    bigint,
  warranty_until date,
  location_code text,
  status        text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','issued','in_repair','lost','retired')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, tag),
  FOREIGN KEY (tenant_id, category_id) REFERENCES asset_categories (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS asset_assignments (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  asset_id      uuid NOT NULL,
  employee_id   uuid NOT NULL,
  issued_on     date NOT NULL DEFAULT CURRENT_DATE,
  issued_by_user_id uuid,
  issue_condition text,
  acknowledged_at timestamptz,
  returned_on   date,
  return_condition text CHECK (return_condition IS NULL OR return_condition IN ('good','damaged','lost')),
  return_note   text,
  received_by_user_id uuid,
  recovery_paise bigint NOT NULL DEFAULT 0,           -- charged for damage/loss; rolls into exit recoveries when applicable
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS asset_assignments_one_open_idx ON asset_assignments (tenant_id, asset_id) WHERE returned_on IS NULL;
CREATE INDEX IF NOT EXISTS asset_assignments_employee_idx ON asset_assignments (tenant_id, employee_id) WHERE returned_on IS NULL;

CREATE TABLE IF NOT EXISTS asset_maintenance (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL,
  kind        text NOT NULL DEFAULT 'repair' CHECK (kind IN ('repair','service','upgrade')),
  opened_on   date NOT NULL DEFAULT CURRENT_DATE,
  closed_on   date,
  vendor      text,
  cost_paise  bigint,
  note        text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets (tenant_id, id)
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['asset_categories','assets','asset_assignments','asset_maintenance'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
