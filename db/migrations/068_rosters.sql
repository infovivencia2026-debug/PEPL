-- Rosters, shift swaps, optional holidays, overtime pre-approval (blueprint B1).
--
-- shift_rosters (existing) is the STANDING assignment: "Ravi is on A shift
-- from 1 Oct". roster_days is the PLAN: a specific shift (or a weekly off) for
-- a specific person on a specific date — what a factory or store supervisor
-- draws up week by week, rotating offs. A day-level row wins over the standing
-- shift; both win over the company-wide week pattern.

CREATE TABLE IF NOT EXISTS roster_days (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL,
  work_date    date NOT NULL,
  shift_id     uuid,                                  -- NULL with is_off = weekly off that day
  is_off       boolean NOT NULL DEFAULT false,
  source       text NOT NULL DEFAULT 'planned' CHECK (source IN ('planned','pattern','swap')),
  published    boolean NOT NULL DEFAULT true,
  created_by_user_id uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts (tenant_id, id),
  CHECK (is_off OR shift_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS roster_days_date_idx ON roster_days (tenant_id, work_date, shift_id);

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS min_headcount int NOT NULL DEFAULT 0 CHECK (min_headcount >= 0);

CREATE TABLE IF NOT EXISTS shift_swaps (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  requester_employee_id   uuid NOT NULL,
  counterpart_employee_id uuid NOT NULL,
  work_date       date NOT NULL,
  requester_shift_id   uuid,                          -- what each has on that date (NULL = off)
  counterpart_shift_id uuid,
  reason          text,
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','declined','approved','rejected','cancelled')),
  approval_request_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, requester_employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, counterpart_employee_id) REFERENCES employees (tenant_id, id),
  CHECK (requester_employee_id <> counterpart_employee_id)
);

CREATE TABLE IF NOT EXISTS optional_holiday_picks (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  holiday_id  uuid NOT NULL,
  holiday_on  date NOT NULL,
  picked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_id, holiday_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, holiday_id) REFERENCES holidays (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ot_requests (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL,
  work_date     date NOT NULL,
  minutes       int  NOT NULL CHECK (minutes BETWEEN 15 AND 720),
  reason        text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approval_request_id uuid,
  requested_by_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ot_requests_one_live_idx ON ot_requests (tenant_id, employee_id, work_date) WHERE status IN ('pending','approved');

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['roster_days','shift_swaps','optional_holiday_picks','ot_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
