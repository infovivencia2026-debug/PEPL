-- Attendance. See docs/architecture/leave-attendance-ops.md §2, §3, §5.
--
-- Raw capture is append-only and never edited. Everything downstream is DERIVED
-- and recomputable, so a correction is a new fact rather than the destruction of
-- an old one — which is what lets a locked payroll run stay reproducible after
-- six months of HR corrections.

CREATE TABLE IF NOT EXISTS attendance_punches (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL,
  punched_at      timestamptz NOT NULL,
  local_date      date NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('in','out')),
  source          text NOT NULL CHECK (source IN ('mobile','web','biometric_import','manual')),
  geo_lat         numeric(9,6),
  geo_lng         numeric(9,6),
  within_geofence boolean,
  -- idempotency for the mobile offline queue: a retried punch is a no-op
  client_punch_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS punch_client_idempotency_idx
  ON attendance_punches (tenant_id, employee_id, client_punch_id)
  WHERE client_punch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS punch_day_idx
  ON attendance_punches (tenant_id, employee_id, local_date);

-- The close gate. A correction dated inside a closed period is refused; one
-- dated inside a frozen period can never apply and is routed to the next.
CREATE TABLE IF NOT EXISTS attendance_periods (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','frozen')),
  closed_by_user_id uuid,
  closed_at         timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, period_start),
  CHECK (period_end >= period_start)
);

-- Derived projection of punches + corrections + leave. Recompute is idempotent.
CREATE TABLE IF NOT EXISTS daily_attendance (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  employee_id    uuid NOT NULL,
  work_date      date NOT NULL,
  first_in       timestamptz,
  last_out       timestamptz,
  worked_minutes int NOT NULL DEFAULT 0,
  -- status and the attributes are ORTHOGONAL: someone can be remote AND half-day,
  -- or on field duty AND on a holiday. Encoding remote as a status forces a false
  -- choice and collides in the muster view.
  status         text NOT NULL DEFAULT 'absent'
                 CHECK (status IN ('present','absent','weekly_off','holiday','on_leave','on_duty','not_joined')),
  day_fraction   numeric(3,2) NOT NULL DEFAULT 1.00 CHECK (day_fraction IN (0, 0.5, 1)),
  fraction_source text,          -- system | manager_marked | leave | regularization
  is_remote      boolean NOT NULL DEFAULT false,
  is_field_duty  boolean NOT NULL DEFAULT false,
  is_regularized boolean NOT NULL DEFAULT false,
  marked_by_user_id uuid,
  marked_reason  text,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

-- Append-only. Nothing is overwritten: daily_attendance is replayable from
-- punches + this table, so any day can show what it looked like before a manager
-- touched it, and who touched it.
CREATE TABLE IF NOT EXISTS attendance_corrections (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  id             bigint GENERATED ALWAYS AS IDENTITY,
  employee_id    uuid NOT NULL,
  work_date      date NOT NULL,
  action         text NOT NULL CHECK (action IN
                   ('set_punch_in','set_punch_out','add_day','mark_absent','mark_present',
                    'mark_half_day','mark_full_day','mark_remote','revoke_remote',
                    'mark_field_duty','mark_leave','clear_leave')),
  before         jsonb NOT NULL DEFAULT '{}'::jsonb,
  after          jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason         text NOT NULL,
  actor_user_id  uuid,
  source         text NOT NULL DEFAULT 'hr_console',
  applied_at     timestamptz NOT NULL DEFAULT now(),
  -- set when the target period was frozen and the effect was pushed forward
  deferred_to_period_id uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS corrections_day_idx
  ON attendance_corrections (tenant_id, employee_id, work_date, id);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_punches','attendance_periods','daily_attendance','attendance_corrections'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  -- Raw capture and the correction trail are both immutable.
  EXECUTE format('REVOKE UPDATE, DELETE ON attendance_punches FROM %I', app_role);
  EXECUTE format('REVOKE UPDATE, DELETE ON attendance_corrections FROM %I', app_role);
END $$;
