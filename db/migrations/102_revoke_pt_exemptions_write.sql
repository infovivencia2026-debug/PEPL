-- pt_exemptions is the law, and the application role must not be able to edit it.
--
-- 099 created the table and never revoked the default write grant, so pepl_app
-- held INSERT, UPDATE and DELETE on it -- while pt_slabs and statutory_configs,
-- the same kind of fact, were read-only (009). One request that reached the
-- runtime connection could have changed who is exempt from professional tax for
-- EVERY company, and the change would have looked like reference data.
--
-- Reference rows are loaded by the seed under the owner role, which is unaffected.

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pt_exemptions FROM %I', app_role);
  EXECUTE format('GRANT SELECT ON pt_exemptions TO %I', app_role);
END $$;
