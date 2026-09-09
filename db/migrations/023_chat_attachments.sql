-- Chat attachments.
--
-- A message points at documents rather than carrying bytes: one storage path
-- for every file in the product, one retention rule, and a 40 MB photo never
-- lands in a message list query.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS attachment_document_ids uuid[] NOT NULL DEFAULT '{}';

-- Editing and deleting your own message is table stakes for a chat product, and
-- both are already columns (edited_at, deleted_at); the app role needs UPDATE.
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT UPDATE ON messages, conversations, conversation_participants TO %I', app_role);
END $$;
