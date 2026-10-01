-- One live mailbox per address in a company.
--
-- `addInternalAddress` and `connectMailbox` checked for an existing mailbox first, but nothing in the
-- database enforced it, so two concurrent requests -- or any future code path -- could leave two
-- live mailboxes on one address and internal delivery would have to guess which one is real.
--
-- Partial on the same "live" definition the code uses, so a disconnected or removed mailbox does not
-- block the address being claimed again. If this fails on an existing database, two live mailboxes
-- already share an address: remove or disconnect one, then re-run.

CREATE UNIQUE INDEX IF NOT EXISTS mail_accounts_one_live_address
  ON mail_accounts (tenant_id, lower(email))
  WHERE status NOT IN ('disconnected', 'removed');
