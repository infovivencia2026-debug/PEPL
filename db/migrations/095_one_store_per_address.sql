-- One address belongs to ONE identity store.
--
-- 094 put operators in their own tables so a bug could not confuse a customer
-- with an operator. 095 is what makes the single login form safe on top of
-- that: the form looks an address up in both stores, so if an address could
-- exist in both, "which one did this password just open?" would be a real
-- question. It must never be askable.
--
-- Enforced by triggers rather than by the two service functions, because a
-- service check is one new code path away from being skipped, and the whole
-- point is that no path can create the ambiguity.

-- control_plane has no row-level security and is owned by pepl_owner, so a
-- definer function here genuinely reads the table. (On a TENANT table it would
-- not: FORCE ROW LEVEL SECURITY applies to the owner too.)
CREATE OR REPLACE FUNCTION platform_email_exists(addr text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM control_plane.platform_users WHERE lower(email) = lower(addr))
$$;
REVOKE ALL ON FUNCTION platform_email_exists(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_email_exists(text) TO pepl_app;

COMMENT ON FUNCTION platform_email_exists(text) IS
  'Existence only. Deliberately returns no operator detail to the application role.';

CREATE OR REPLACE FUNCTION app_user_not_an_operator() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF platform_email_exists(NEW.email) THEN
    RAISE EXCEPTION 'address % belongs to a PEPL operator', NEW.email
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS app_users_not_an_operator ON app_users;
CREATE TRIGGER app_users_not_an_operator
  BEFORE INSERT OR UPDATE OF email ON app_users
  FOR EACH ROW EXECUTE FUNCTION app_user_not_an_operator();

-- ... and the other direction. This one runs on the control connection, which
-- has BYPASSRLS, so it genuinely sees every tenant's users.
CREATE OR REPLACE FUNCTION operator_not_an_app_user() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_users WHERE lower(email) = lower(NEW.email)) THEN
    RAISE EXCEPTION 'address % already belongs to a customer account', NEW.email
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS platform_users_not_an_app_user ON control_plane.platform_users;
CREATE TRIGGER platform_users_not_an_app_user
  BEFORE INSERT OR UPDATE OF email ON control_plane.platform_users
  FOR EACH ROW EXECUTE FUNCTION operator_not_an_app_user();
