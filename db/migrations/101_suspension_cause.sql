-- Who suspended this customer.
--
-- The nightly dunning job suspends a company that has not paid and reactivates it
-- once nothing is owed. Its reactivation rule was "suspended, trial over, no
-- invoice due" -- which is equally true of a customer an operator suspended ON
-- PURPOSE: a contract dispute, an abuse complaint, someone who asked to be paused.
-- The next night the job saw nothing unpaid and switched them back on.
--
-- Recording the cause lets the job lift only what it put there.
--
--   'automatic'  suspended by the dunning job (non-payment or an ended trial); the job
--                may reactivate it once the reason has gone away
--   'operator'   suspended by a person; nothing but a person lifts it
--   NULL         no cause recorded. Every row that predates this column is in that
--                state, and it is treated as an operator's decision: reactivating a
--                suspension nobody can explain is the bug this fixes, so the safe
--                reading of "unknown" is "leave it alone".
--
-- No backfill for the same reason.

ALTER TABLE control_plane.subscriptions
  ADD COLUMN IF NOT EXISTS suspension_cause text
  CHECK (suspension_cause IN ('operator', 'automatic'));

COMMENT ON COLUMN control_plane.subscriptions.suspension_cause IS
  'Who suspended this subscription. Only automatic suspensions are lifted by the dunning job; NULL means unknown and is treated as an operator decision.';
