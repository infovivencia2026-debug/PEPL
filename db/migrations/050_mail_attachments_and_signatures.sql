-- Mail attachments become documents owned by the mailbox, and a mailbox gets
-- a signature.
--
-- An inbound attachment used to be a boolean (`has_attachment`) with the bytes
-- left on the IMAP server; the parser now extracts every part, so it needs a
-- home. `owner_type = 'mail'` with `owner_id = mail_accounts.id` puts it under
-- the same retention, erasure and storage rules as every other file, and the
-- mail routes are the only reader: the generic document routes refuse the type
-- unless the caller owns that mailbox.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_owner_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_owner_type_check
  CHECK (owner_type IN ('employee','ticket','conversation','tenant','mail'));

-- Which stored parts are inline images, keyed by the Content-ID the HTML refers to.
CREATE TABLE IF NOT EXISTS mail_attachments (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  envelope_id  uuid NOT NULL,
  document_id  uuid NOT NULL,
  content_id   text,
  is_inline    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, envelope_id, document_id),
  FOREIGN KEY (tenant_id, envelope_id) REFERENCES mail_envelopes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE mail_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_attachments;
CREATE POLICY tenant_isolation ON mail_attachments
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_attachments TO pepl_app;

-- Signature and reply-to, per mailbox. HTML, sanitised on write.
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS signature_html text;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS reply_to text;

-- Drafts and sent mail already carry bcc_addresses; drafts now carry attachments too
-- (the column exists on mail_envelopes since 024). Nothing to add.
