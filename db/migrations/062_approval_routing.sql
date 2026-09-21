-- A step that had nobody to approve it can now be routed to HR instead of
-- skipped (setting approvals.no_approver_fallback); the step records that so
-- the inbox can say "you are seeing this because X has no manager on record".
-- reminded_at throttles the daily nudge from remindStale().
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS routed_to_hr boolean NOT NULL DEFAULT false;
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
