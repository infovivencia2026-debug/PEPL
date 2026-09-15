-- Shifts and rosters.
--
-- `attendance.week_pattern = 'roster'` has been a value with nothing behind it,
-- and a punch at 11:40 was "present" whether the shift started at 09:00 or
-- 22:00. A shift says when the day starts and ends, how much grace there is
-- either side, how long the break is, and when overtime begins. The roster
-- says who is on which shift from when — versioned, never edited in place,
-- like every other rule that decides pay.
CREATE TABLE IF NOT EXISTS shifts (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  code          text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  start_time    time NOT NULL,
  end_time      time NOT NULL,          -- earlier than start_time means it crosses midnight
  grace_in_min  int  NOT NULL DEFAULT 10 CHECK (grace_in_min BETWEEN 0 AND 120),
  grace_out_min int  NOT NULL DEFAULT 0  CHECK (grace_out_min BETWEEN 0 AND 120),
  break_min     int  NOT NULL DEFAULT 60 CHECK (break_min BETWEEN 0 AND 240),
  -- Worked minutes (after break) at or above this is a full day; between the
  -- two is a half day; below the half is absent. Replaces the company-wide
  -- half_day_hours for anyone on a shift.
  full_day_min  int  NOT NULL CHECK (full_day_min BETWEEN 60 AND 960),
  half_day_min  int  NOT NULL CHECK (half_day_min BETWEEN 30 AND 720),
  -- Overtime starts this many minutes after the scheduled end; 0 disables.
  ot_after_min  int  NOT NULL DEFAULT 0 CHECK (ot_after_min BETWEEN 0 AND 240),
  ot_eligible   boolean NOT NULL DEFAULT false,
  -- 0 = Sunday … 6 = Saturday. Replaces week_pattern for people on this shift.
  weekly_off_days int[] NOT NULL DEFAULT '{0}',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  retired_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (half_day_min < full_day_min)
);

CREATE TABLE IF NOT EXISTS shift_rosters (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL,
  shift_id       uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  created_by_user_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts (tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS shift_rosters_lookup_idx ON shift_rosters (tenant_id, employee_id, effective_from DESC);

-- What the shift made of the day. Late and early are against the schedule
-- after grace; OT is beyond the scheduled end after ot_after_min. All three
-- are facts about the day, so payroll can read them at freeze as values.
ALTER TABLE daily_attendance
  ADD COLUMN IF NOT EXISTS shift_id      uuid,
  ADD COLUMN IF NOT EXISTS late_minutes  int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS early_minutes int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ot_minutes    int NOT NULL DEFAULT 0;

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
        t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shifts','shift_rosters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO %I', t, app_role);
    EXECUTE format('REVOKE DELETE ON %I FROM %I', t, app_role);
  END LOOP;
END $$;
