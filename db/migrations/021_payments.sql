-- Payments. See docs/architecture/payments.md.
--
-- PEPL never holds customer money: salary moves from the tenant's own account to
-- their employees. The schema exists to make DOUBLE PAYMENT structurally hard.

CREATE TABLE IF NOT EXISTS employee_bank_accounts (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL,
  beneficiary_name text NOT NULL,
  account_number text NOT NULL,
  ifsc           text NOT NULL,
  bank_name      text,
  is_primary     boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  superseded_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

-- One primary account per employee at a time.
CREATE UNIQUE INDEX IF NOT EXISTS employee_primary_bank_idx
  ON employee_bank_accounts (tenant_id, employee_id)
  WHERE is_primary AND superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS payment_batches (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  source_type          text NOT NULL,
  source_id            uuid NOT NULL,
  channel              text NOT NULL CHECK (channel IN ('bank_file','payout_api')),
  format               text,
  value_date           date NOT NULL,
  instruction_count    int NOT NULL,
  total_paise          bigint NOT NULL,
  file_checksum_sha256 text,
  -- kept so a regenerated download is byte-identical, which is what makes a
  -- retry harmless
  file_content         text,
  status               text NOT NULL DEFAULT 'ready'
                       CHECK (status IN ('draft','ready','submitted','partially_settled','settled','failed','cancelled')),
  generated_by_user_id uuid,
  approved_by_user_id  uuid,
  submitted_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- THE defence: one batch per run per channel. Generating twice returns the
  -- first, it does not mint a second.
  UNIQUE (tenant_id, source_type, source_id, channel)
);

CREATE TABLE IF NOT EXISTS payment_instructions (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               bigint GENERATED ALWAYS AS IDENTITY,
  batch_id         uuid NOT NULL,
  employee_id      uuid NOT NULL,
  beneficiary_name text NOT NULL,
  account_number   text NOT NULL,
  ifsc             text NOT NULL,
  amount_paise     bigint NOT NULL,
  reference        text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','submitted','settled','failed','returned')),
  utr              text,
  failure_reason   text,
  settled_at       timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES payment_batches (tenant_id, id),
  UNIQUE (tenant_id, batch_id, employee_id)
);

CREATE TABLE IF NOT EXISTS payment_events (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  id                bigint GENERATED ALWAYS AS IDENTITY,
  batch_id          uuid,
  instruction_id    bigint,
  event_type        text NOT NULL,
  source            text NOT NULL DEFAULT 'manual',
  provider_event_id text,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source, provider_event_id)
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_bank_accounts','payment_batches','payment_instructions','payment_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO %I', t, app_role);
  END LOOP;
  -- A payment record is never deleted; the trail is what reconciles with a bank.
  EXECUTE format('REVOKE DELETE ON payment_batches, payment_instructions, payment_events FROM %I', app_role);
  EXECUTE format('REVOKE UPDATE, DELETE ON payment_events FROM %I', app_role);
END $$;
