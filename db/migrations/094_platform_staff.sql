-- Platform staff: the people who sell and bill PEPL, as opposed to the people
-- who use it.
--
-- This is the highest-value target in the system and it is worth being explicit
-- about why it is shaped this way.
--
-- Every other identity in PEPL belongs to a tenant, and the whole isolation
-- model rests on that: a session belongs to one company and RLS makes the rest
-- invisible. A platform operator deliberately stands outside it. So they get a
-- SEPARATE identity store — not a flag on app_users — because:
--
--   * a bug that confuses the two tables cannot silently promote a customer's
--     admin into an operator; they are different tables with different columns
--     and different session tables,
--   * `auth_user_by_email` (the tenant credential lookup) cannot ever return an
--     operator, and platform login cannot ever return a tenant user,
--   * revoking an operator cannot accidentally revoke a customer, and
--   * the audit answer to "who did this" is unambiguous.
--
-- It lives in control_plane, which the application role cannot reach at all.
-- pepl_app has no grant here and must never be given one: a compromised
-- customer session must not be able to read, let alone write, the operator
-- table.

CREATE TABLE IF NOT EXISTS control_plane.platform_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  password_hash text,
  -- 'active' | 'suspended'. An operator who leaves is suspended, not deleted,
  -- so the audit trail keeps pointing at a real person.
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  -- Base32 TOTP secret. Null until enrolled; see platform_mfa_required below.
  mfa_secret    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Separate from `sessions` for the same reason the users are separate: a bearer
-- token must resolve to an operator or to a customer, never ambiguously to
-- both, and the resolution paths never touch each other.
CREATE TABLE IF NOT EXISTS control_plane.platform_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES control_plane.platform_users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text,
  -- Set once the second factor is verified. Until then the session exists but
  -- opens nothing.
  mfa_verified_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS platform_sessions_user_idx
  ON control_plane.platform_sessions (user_id, created_at DESC);

-- Deliberately short. An operator session reaches every customer's billing, so
-- it expires in hours, not the thirty days a customer's own session gets.
COMMENT ON TABLE control_plane.platform_sessions IS
  'Operator sessions. Short-lived on purpose: this identity stands outside tenant isolation.';

COMMENT ON TABLE control_plane.platform_users IS
  'PEPL staff, NOT customers. Separate from app_users so the two can never be confused.';
