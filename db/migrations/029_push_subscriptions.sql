-- Web Push (RFC 8030 / 8291 / 8292).
--
-- A browser subscription is an endpoint URL on the browser vendor's push service
-- plus two keys the browser generated. PEPL encrypts every payload to those
-- keys, so the push service relays bytes it cannot read. No APNs/FCM account is
-- needed: the server proves itself with a VAPID keypair from the environment.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  endpoint      text NOT NULL,
  -- The browser's P-256 public key and 16-byte auth secret, base64url as the
  -- browser hands them over. Useless without the browser's private key.
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  failures      int  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_users (tenant_id, id) ON DELETE CASCADE,
  -- One row per browser; re-subscribing from the same browser updates the keys.
  UNIQUE (tenant_id, endpoint)
);

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS pushed_at timestamptz;

CREATE INDEX IF NOT EXISTS notification_push_queue_idx
  ON notifications (tenant_id, created_at)
  WHERE pushed_at IS NULL;

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE push_subscriptions FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON push_subscriptions';
  EXECUTE 'CREATE POLICY tenant_isolation ON push_subscriptions
             USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
  -- Deleting is the normal end of a subscription: the browser revoked it (410)
  -- or the person signed out on that device.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO %I', app_role);
END $$;
