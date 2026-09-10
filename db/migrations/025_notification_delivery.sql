-- Notification delivery.
--
-- A notification row is what the bell shows. Delivering it anywhere else — email
-- today, push later — is a separate fact with its own timestamp, because "we
-- created it" and "it reached them" are different questions and support is
-- always asking the second one.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS emailed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS email_error  text,
  ADD COLUMN IF NOT EXISTS email_attempts int NOT NULL DEFAULT 0;

-- The queue this job drains: unsent, still relevant, and not already failed too
-- often. Partial so it stays small however many notifications accumulate.
CREATE INDEX IF NOT EXISTS notification_email_queue_idx
  ON notifications (tenant_id, created_at)
  WHERE emailed_at IS NULL AND 'email' = ANY(channels);

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  -- The job marks delivery on the existing row; nothing else about a
  -- notification is rewritten.
  EXECUTE format('GRANT UPDATE ON notifications TO %I', app_role);
END $$;
