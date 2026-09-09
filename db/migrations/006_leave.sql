-- Leave. See docs/architecture/leave-attendance-ops.md §1 and §4.
--
-- Balances are DERIVED from an append-only ledger, never stored as a mutable
-- counter. A counter has no memory of how it reached its value, so a wrong
-- balance is unexplainable, a failed annual rollover is invisible, and a
-- re-run accrual double-credits.

CREATE TABLE IF NOT EXISTS leave_types (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  name        text NOT NULL,
  is_paid     boolean NOT NULL DEFAULT true,
  affects_lop boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'active',
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- Versioned, never edited in place: historical ledger entries must stay
-- defensible after a policy changes.
CREATE TABLE IF NOT EXISTS leave_policies (
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  id                       uuid NOT NULL DEFAULT gen_random_uuid(),
  leave_type_id            uuid NOT NULL,
  version                  int NOT NULL,
  accrual_method           text NOT NULL DEFAULT 'monthly',   -- monthly|yearly|on_joining|none
  accrual_units_per_period numeric(6,2) NOT NULL DEFAULT 0,
  max_balance              numeric(6,2),
  carry_forward_limit      numeric(6,2) NOT NULL DEFAULT 0,
  encashable               boolean NOT NULL DEFAULT false,
  allow_negative_balance   boolean NOT NULL DEFAULT false,
  min_unit                 text NOT NULL DEFAULT 'half_day',
  probation_allowed        boolean NOT NULL DEFAULT false,
  effective_from           date NOT NULL,
  effective_to             date,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id),
  UNIQUE (tenant_id, leave_type_id, version)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  -- {"2026-09-14":"full","2026-09-15":"first_half"} — a request carries its shape,
  -- not just a day count.
  day_parts     jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_days    numeric(5,2) NOT NULL CHECK (total_days > 0),
  reason        text,
  status        text NOT NULL DEFAULT 'pending',
  applied_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id),
  CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS leave_ledger (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              bigint GENERATED ALWAYS AS IDENTITY,
  employee_id     uuid NOT NULL,
  leave_type_id   uuid NOT NULL,
  entry_type      text NOT NULL CHECK (entry_type IN
                    ('opening','accrual','consumption','reversal',
                     'encashment','lapse','carry_forward','adjustment')),
  delta_days      numeric(6,2) NOT NULL,
  effective_date  date NOT NULL,
  cycle_year      int NOT NULL,
  source_type     text,
  source_id       uuid,
  -- Makes a re-run a no-op instead of a double credit. This single column is
  -- what makes the accrual job safely repeatable.
  idempotency_key text,
  note            text,
  created_by_user_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS leave_ledger_idempotency_idx
  ON leave_ledger (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS leave_ledger_balance_idx
  ON leave_ledger (tenant_id, employee_id, leave_type_id, cycle_year, effective_date);

-- Compensatory off: work on a weekly off or holiday mints a credit that expires.
CREATE TABLE IF NOT EXISTS comp_off_credits (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL,
  work_date    date NOT NULL,
  expires_on   date NOT NULL,
  status       text NOT NULL DEFAULT 'available',   -- available|consumed|expired
  consumed_ref uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  -- one credit per worked date, so a re-run cannot double-mint
  UNIQUE (tenant_id, employee_id, work_date)
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['leave_types','leave_policies','leave_requests','leave_ledger','comp_off_credits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  -- The ledger is append-only: a cancellation writes a reversal, it never
  -- deletes the consumption that is being reversed.
  EXECUTE format('REVOKE UPDATE, DELETE ON leave_ledger FROM %I', app_role);
END $$;
