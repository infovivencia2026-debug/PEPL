-- One person, several companies.
--
-- An accountant or a consultant works for more than one client, and a
-- salesperson demoing needs their own copy of a demo company. Until now an
-- email could exist in exactly one tenant: `auth_user_by_email` returned rows
-- only when the address was unique across the platform, so a duplicate did not
-- fail loudly — it failed CLOSED, and neither account could sign in.
--
-- That guard was right. Picking a company for an ambiguous email would be
-- choosing, on the user's behalf, whose payroll they are about to open. What
-- replaces it keeps the same property and moves the decision to the only place
-- it can safely be made: after the password has been proven.
--
--   1. This function now returns every candidate for the address.
--   2. login() verifies the password against each one and keeps only the
--      matches, so nothing about an account is revealed to somebody who cannot
--      already authenticate as it.
--   3. One match signs in exactly as before. Several match only when the person
--      genuinely holds both accounts WITH THE SAME PASSWORD, and then they are
--      asked which company — never told, before proving it, that the other
--      exists.
--
-- A session stays scoped to one tenant, as it always was. Working in another
-- company means another session; nothing spans two.

CREATE OR REPLACE FUNCTION auth_user_by_email(p_email text)
RETURNS TABLE(tenant_id uuid, id uuid, password_hash text, status text, employee_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.tenant_id, u.id, u.password_hash, u.status, u.employee_id
  FROM public.app_users u
  WHERE lower(u.email) = lower(p_email)
  -- Deterministic, so a person with two accounts is offered them in a stable
  -- order rather than whatever the planner returns today.
  ORDER BY u.created_at, u.tenant_id
$$;

COMMENT ON FUNCTION auth_user_by_email(text) IS
  'Every credential row for an address. The CALLER must verify the password against each and may act only on the matches.';

-- The half-finished login: which accounts a proven password opened, and
-- nothing else. Global rather than tenant-scoped for the same reason
-- login_attempts is — it exists BEFORE a tenant has been chosen, which is the
-- whole point of it. It holds an email and a list of ids; no tenant data.
--
-- Single-use and short-lived: a token that could be replayed would let anyone
-- who saw it once pick a different company later.
CREATE TABLE IF NOT EXISTS login_choices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  email       text NOT NULL,
  -- [{ "tenantId": uuid, "userId": uuid }] — only the accounts the password matched.
  candidates  jsonb NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_choices_expiry_idx ON login_choices (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON login_choices TO pepl_app;

COMMENT ON TABLE login_choices IS
  'A login that proved its password and now needs a company. Single-use, minutes long.';
