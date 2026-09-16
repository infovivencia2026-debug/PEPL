-- One person, several mailboxes.
--
-- The schema always allowed it (UNIQUE (tenant_id, user_id, email)); the code
-- picked the oldest and called it "the" mailbox. Two columns make the choice
-- explicit: a label for the account switcher, and which one opens by default.
-- No backfill: "default" is computed as is_default DESC, created_at, so an
-- existing single mailbox is the default without a migration writing a
-- tenant-scoped row (which RLS would silently turn into a no-op anyway).
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- At most one default per person.
CREATE UNIQUE INDEX IF NOT EXISTS mail_account_default_idx
  ON mail_accounts (tenant_id, user_id) WHERE is_default;

-- A removed mailbox keeps its rows for retention but stops receiving and sending.
ALTER TABLE mail_accounts DROP CONSTRAINT IF EXISTS mail_accounts_status_check;
ALTER TABLE mail_accounts ADD CONSTRAINT mail_accounts_status_check
  CHECK (status IN ('connected','auth_failed','disconnected','removed'));
