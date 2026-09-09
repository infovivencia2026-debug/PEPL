-- The runtime role owns nothing and bypasses nothing; it only holds DML.
DO $$
DECLARE app_role text := current_setting('pepl.app_role', true);
BEGIN
  IF app_role IS NULL OR app_role = '' THEN app_role := 'pepl_app'; END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app_role);
  EXECUTE format('REVOKE ALL ON TABLE _migrations FROM %I', app_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', app_role);
END $$;
