-- Communication. See docs/architecture/communication.md and mail.md.
--
-- Announcements, notifications, chat and mail are FOUR different things sharing
-- a substrate, not one "messages" table. Chat optimises for a fast append-only
-- stream with per-participant delivery state; mail for addressing and retrieval;
-- announcements for audience and acknowledgement.

-- ---------------------------------------------------------------------------
-- Announcements: a publication with an audience and an acknowledgement
-- requirement. Acknowledgement with a name, a timestamp and a version is what
-- makes this an HR feature rather than a noticeboard.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS announcements (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  title          text NOT NULL,
  body_html      text NOT NULL,
  author_user_id uuid,
  audience       jsonb NOT NULL DEFAULT '{"all":true}'::jsonb,
  channels       text[] NOT NULL DEFAULT '{in_app}',
  requires_acknowledgement boolean NOT NULL DEFAULT false,
  version        int NOT NULL DEFAULT 1,
  publish_at     timestamptz,
  expires_at     timestamptz,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','published','expired','withdrawn')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS announcement_receipts (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  announcement_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  delivered_at    timestamptz,
  viewed_at       timestamptz,
  acknowledged_at timestamptz,
  PRIMARY KEY (tenant_id, announcement_id, user_id),
  FOREIGN KEY (tenant_id, announcement_id) REFERENCES announcements (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Notifications: system events reaching a person on a channel.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          bigint GENERATED ALWAYS AS IDENTITY,
  user_id     uuid NOT NULL,
  event_type  text NOT NULL,
  title       text NOT NULL,
  body        text,
  entity_type text,
  entity_id   uuid,
  channels    text[] NOT NULL DEFAULT '{in_app}',
  read_at     timestamptz,
  -- one notification per (user, event, entity): a retried job does not spam
  dedupe_key  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_dedupe_idx
  ON notifications (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_unread_idx
  ON notifications (tenant_id, user_id, read_at, created_at DESC);

-- ---------------------------------------------------------------------------
-- Chat. Partitioning and receipts are deferred to the scale work; the shape and
-- the isolation rules are what matter now.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('dm','group','announcement','support')),
  title           text,
  created_by_user_id uuid,
  -- a group that mirrors an org unit and updates as people move
  auto_scope_type text,
  auto_scope_id   uuid,
  is_readonly     boolean NOT NULL DEFAULT false,
  last_message_at timestamptz,
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  role            text NOT NULL DEFAULT 'member',
  joined_at       timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  muted_until     timestamptz,
  -- read state as a WATERMARK, one row per member updated in place, rather than
  -- a receipt row per message per member (which is 60k rows/day in a 300-person
  -- group and the first thing to fall over)
  last_read_message_id bigint,
  PRIMARY KEY (tenant_id, conversation_id, user_id),
  -- the composite FK is what makes a cross-tenant conversation impossible
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS messages (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  conversation_id   uuid NOT NULL,
  id                bigint GENERATED ALWAYS AS IDENTITY,
  client_message_id text NOT NULL,
  sender_user_id    uuid,
  body              text,
  content_type      text NOT NULL DEFAULT 'text',
  reply_to_message_id bigint,
  -- an HR object rendered inline: the feature that justifies chat living here
  hrms_ref          jsonb,
  edited_at         timestamptz,
  deleted_at        timestamptz,
  sent_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  UNIQUE (tenant_id, conversation_id, client_message_id)
);

-- ---------------------------------------------------------------------------
-- Mail: PEPL is a mail CLIENT. Credentials are the most sensitive data here
-- after bank details.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_accounts (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL,
  email                text NOT NULL,
  display_name         text,
  provider             text NOT NULL DEFAULT 'imap_generic',
  auth_type            text NOT NULL DEFAULT 'password' CHECK (auth_type IN ('oauth2','password')),
  imap_host            text, imap_port int, imap_secure boolean,
  smtp_host            text, smtp_port int, smtp_secure boolean,
  username             text,
  secret_ciphertext    bytea,
  secret_key_version   int NOT NULL DEFAULT 1,
  status               text NOT NULL DEFAULT 'connected',
  last_error           text,
  consecutive_failures int NOT NULL DEFAULT 0,
  quarantined_until    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, user_id, email)
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['announcements','announcement_receipts','notifications',
                           'conversations','conversation_participants','messages','mail_accounts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  -- A message is edited or tombstoned, never erased out from under a retention
  -- policy or a legal hold.
  EXECUTE format('REVOKE DELETE ON messages FROM %I', app_role);
END $$;
