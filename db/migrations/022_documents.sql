-- Documents. Offer letters, ID proofs, policy attachments, chat and mail files.
--
-- Content lives in `document_blobs`, split from the metadata row so a list query
-- never drags megabytes through the pool. Bytes are held in Postgres for now:
-- one fewer credential to custody at launch, and the storage backend is a
-- column (`storage`) rather than an assumption, so moving to object storage is
-- a new value and a reader branch, not a schema change.

CREATE TABLE IF NOT EXISTS documents (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  -- what the document hangs off: employee | ticket | conversation | tenant
  owner_type      text NOT NULL CHECK (owner_type IN ('employee','ticket','conversation','tenant')),
  owner_id        uuid,
  category        text,
  file_name       text NOT NULL,
  content_type    text NOT NULL,
  size_bytes      int NOT NULL CHECK (size_bytes >= 0),
  sha256          text NOT NULL,
  storage         text NOT NULL DEFAULT 'db' CHECK (storage IN ('db','object')),
  storage_key     text,
  -- payslips, medical notes, disciplinary letters: visible to the subject and to
  -- an explicit permission, never to a colleague browsing a folder
  is_confidential boolean NOT NULL DEFAULT false,
  uploaded_by_user_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_reason  text,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS documents_owner_idx
  ON documents (tenant_id, owner_type, owner_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS document_blobs (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL,
  bytes       bytea NOT NULL,
  PRIMARY KEY (tenant_id, document_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['documents','document_blobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO %I', t, app_role);
  END LOOP;
  -- Deletion is a tombstone on `documents`; the blob goes for real so a
  -- retention request actually removes the bytes.
  EXECUTE format('GRANT DELETE ON document_blobs TO %I', app_role);
END $$;
