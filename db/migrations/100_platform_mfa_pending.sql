-- A second factor must not exist until somebody has proved they hold it.
--
-- Enrolment used to write the secret straight into `mfa_secret` the moment the
-- QR code was shown. Two things followed from that, both bad:
--
--   * Close the tab before scanning and the account was ENROLLED with a secret
--     nobody held. The next sign-in demanded a code that existed nowhere.
--   * Because the secret was live from the start, the enrol route could not
--     tell "first-time set-up" from "replace an existing factor", so it allowed
--     both -- and a session that had cleared only the PASSWORD could overwrite
--     an enrolled operator's authenticator with its own.
--
-- The secret now waits here. It is promoted to `mfa_secret` only by a code that
-- verifies against it, and `mfa_secret` is never writable from a route again:
-- changing an enrolled factor is an operator reset from the shell, not a request.

ALTER TABLE control_plane.platform_users
  ADD COLUMN IF NOT EXISTS mfa_pending_secret text;

COMMENT ON COLUMN control_plane.platform_users.mfa_pending_secret IS
  'Shown as a QR code but not yet proved. Promoted to mfa_secret by the first valid code; never consulted for an enrolled account.';

-- An account left holding a live secret from the old flow that was never
-- verified cannot be told apart from one that was, so nothing is rewritten
-- here. The shell reset (ops staff-reset-mfa) is the way back for such an
-- account.
