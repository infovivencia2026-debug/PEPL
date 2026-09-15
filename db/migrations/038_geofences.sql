-- Geofence sites.
--
-- `attendance.geofence_required` has existed since the attendance module and
-- `attendance_punches.within_geofence` was written from a flag THE PHONE SENT.
-- There was no fence: nothing defined where the office is, so the flag could
-- only ever be enforced against a boundary that did not exist, by trusting
-- the device it was meant to check. From here the server decides, from these
-- rows and the haversine distance to the punch.
CREATE TABLE IF NOT EXISTS geofence_sites (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  lat         numeric(9,6) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         numeric(9,6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
  -- 50 m is a GPS fix on a good day; 2 km is a campus. Outside that is a typo.
  radius_m    int NOT NULL CHECK (radius_m BETWEEN 25 AND 5000),
  -- A one-office company sets this and never assigns anyone.
  applies_to_all boolean NOT NULL DEFAULT false,
  -- Optional link to the location master, so a report can group by it.
  location_code text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  retired_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- Who may punch where. A row with a site is membership; a row with `exempt`
-- is field staff who punch from anywhere and are recorded, never rejected.
CREATE TABLE IF NOT EXISTS geofence_members (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  site_id     uuid,
  exempt      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES geofence_sites (tenant_id, id),
  CHECK ((site_id IS NOT NULL) <> exempt),
  UNIQUE NULLS NOT DISTINCT (tenant_id, employee_id, site_id)
);

-- The server's verdict, kept beside the phone's coordinates. `distance_m` is
-- to the nearest site the person may use; NULL when they have none.
ALTER TABLE attendance_punches
  ADD COLUMN IF NOT EXISTS site_id    uuid,
  ADD COLUMN IF NOT EXISTS distance_m int;

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
        t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['geofence_sites','geofence_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON geofence_sites TO %I', app_role);
  EXECUTE format('REVOKE DELETE ON geofence_sites FROM %I', app_role);
  -- Membership is the one thing here that IS deleted: leaving a site is not history.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON geofence_members TO %I', app_role);
END $$;
