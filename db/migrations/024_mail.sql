-- Mail. See docs/architecture/mail.md.
--
-- PEPL is a mail CLIENT for external accounts and a mail SERVER for nothing:
-- there is no MX record here. Two things therefore share these tables:
--
--   * internal mail — colleague to colleague, delivered straight into the
--     recipient's Inbox by the app, with the body stored because there is no
--     other copy of it anywhere
--   * external mail — envelopes cached from the tenant's own IMAP server for
--     the list view, with the body fetched on open unless mail.store_bodies is
--     switched on
--
-- Every mutation goes through mail_commands rather than running inline, so a
-- send that fails is a retryable row and not a lost message.

CREATE TABLE IF NOT EXISTS mail_folders (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL,
  path           text NOT NULL,
  name           text NOT NULL,
  role           text CHECK (role IN ('inbox','sent','drafts','trash','junk','archive','custom')),
  uid_validity   bigint,
  uid_next       bigint,
  highest_modseq bigint,
  last_synced_at timestamptz,
  subscribed     boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES mail_accounts (tenant_id, id),
  UNIQUE (tenant_id, account_id, path)
);

-- One folder per role per account: an Inbox is not something you can have two of.
CREATE UNIQUE INDEX IF NOT EXISTS mail_folder_role_idx
  ON mail_folders (tenant_id, account_id, role)
  WHERE role IS NOT NULL AND role <> 'custom';

CREATE TABLE IF NOT EXISTS mail_envelopes (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL,
  folder_id       uuid NOT NULL,
  -- 'internal' rows are authored here; 'imap' rows are a cache of a server row
  source          text NOT NULL DEFAULT 'internal' CHECK (source IN ('internal','imap')),
  uid             bigint,
  message_id      text,
  thread_key      text,
  in_reply_to     text,
  from_name       text,
  from_address    text,
  to_addresses    jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses    jsonb NOT NULL DEFAULT '[]'::jsonb,
  bcc_addresses   jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject         text,
  preview         text,
  sent_at         timestamptz,
  received_at     timestamptz NOT NULL DEFAULT now(),
  size_bytes      int,
  is_seen         boolean NOT NULL DEFAULT false,
  is_flagged      boolean NOT NULL DEFAULT false,
  is_answered     boolean NOT NULL DEFAULT false,
  is_draft        boolean NOT NULL DEFAULT false,
  has_attachment  boolean NOT NULL DEFAULT false,
  attachment_document_ids uuid[] NOT NULL DEFAULT '{}',
  deleted_at      timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES mail_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, folder_id) REFERENCES mail_folders (tenant_id, id)
);

-- A cached IMAP row is identified by its server uid; two syncs must not
-- duplicate it. Internal mail has no uid, so the constraint does not apply.
CREATE UNIQUE INDEX IF NOT EXISTS mail_envelope_uid_idx
  ON mail_envelopes (tenant_id, account_id, folder_id, uid)
  WHERE uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS mail_envelope_list_idx
  ON mail_envelopes (tenant_id, folder_id, received_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS mail_envelope_thread_idx
  ON mail_envelopes (tenant_id, account_id, thread_key);

-- Bodies are separate so a 50-message list view reads none of them.
CREATE TABLE IF NOT EXISTS mail_bodies (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  envelope_id uuid NOT NULL,
  body_html   text,
  body_text   text,
  cached_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, envelope_id),
  FOREIGN KEY (tenant_id, envelope_id) REFERENCES mail_envelopes (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mail_commands (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL,
  user_id         uuid NOT NULL,
  command         text NOT NULL CHECK (command IN
                    ('send','reply','flag','unflag','seen','unseen','move','delete','save_draft','append')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','done','failed','abandoned')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES mail_accounts (tenant_id, id),
  UNIQUE (tenant_id, account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS mail_command_queue_idx
  ON mail_commands (tenant_id, status, created_at)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS mail_delegations (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL,
  grantee_user_id     uuid NOT NULL,
  access              text NOT NULL CHECK (access IN ('read','send_as','send_on_behalf','full')),
  granted_by_user_id  uuid NOT NULL,
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES mail_accounts (tenant_id, id),
  UNIQUE (tenant_id, account_id, grantee_user_id)
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['mail_folders','mail_envelopes','mail_bodies','mail_commands','mail_delegations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  -- A queued command is the audit trail of what was asked for; it is completed
  -- or abandoned, never quietly removed.
  EXECUTE format('REVOKE DELETE ON mail_commands FROM %I', app_role);
END $$;
