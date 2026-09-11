-- The readiness probe counts _migrations as the runtime role, and 003 revoked
-- ALL on that table from it — so /health/ready answered 503 in every real
-- deployment while the unit tests, which never called it, stayed green. Found
-- by booting the production image simulation. Reading the ledger is harmless;
-- writing it stays revoked.
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT SELECT ON TABLE _migrations TO %I', app_role);
END $$;
