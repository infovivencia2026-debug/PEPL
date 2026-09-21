-- Recruitment: from "we need a person" to "they are an employee".
--
-- A requisition (approved headcount) opens a job; candidates enter a
-- pipeline of stages; interviews are scheduled and scored; an offer is made
-- (approved through the engine above a CTC threshold) and accepted; the
-- accepted candidate is CONVERTED into an employee — one call that creates
-- the record, the first assignment, the compensation, the login invite and
-- the onboarding checklist. Nothing about the candidate is copied by hand.

CREATE TABLE IF NOT EXISTS job_requisitions (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  department       text,
  location_code    text,
  grade_code       text,
  designation      text,
  headcount        int NOT NULL DEFAULT 1 CHECK (headcount BETWEEN 1 AND 500),
  employment_type  text NOT NULL DEFAULT 'permanent',
  min_ctc_paise    bigint,
  max_ctc_paise    bigint,
  justification    text,
  hiring_manager_employee_id uuid,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','open','on_hold','filled','cancelled')),
  approval_request_id uuid,
  requested_by_user_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  PRIMARY KEY (tenant_id, id),
  CHECK (max_ctc_paise IS NULL OR min_ctc_paise IS NULL OR max_ctc_paise >= min_ctc_paise)
);

CREATE TABLE IF NOT EXISTS candidates (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  requisition_id   uuid NOT NULL,
  first_name       text NOT NULL,
  last_name        text,
  email            text NOT NULL,
  phone            text,
  source           text,                                   -- referral, portal, agency, walk-in
  referred_by_employee_id uuid,
  resume_document_id uuid,
  current_ctc_paise bigint,
  expected_ctc_paise bigint,
  notice_days      int,
  stage            text NOT NULL DEFAULT 'applied'
        CHECK (stage IN ('applied','screening','interview','offer','offered','accepted','joined','rejected','withdrawn')),
  rejection_reason text,
  notes            text,
  employee_id      uuid,                                   -- set when converted
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, requisition_id) REFERENCES job_requisitions (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS candidates_req_email_idx ON candidates (tenant_id, requisition_id, lower(email));
CREATE INDEX IF NOT EXISTS candidates_req_stage_idx ON candidates (tenant_id, requisition_id, stage);

CREATE TABLE IF NOT EXISTS interviews (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  candidate_id     uuid NOT NULL,
  round            text NOT NULL,                          -- 'screening', 'technical 1', 'HR', …
  scheduled_at     timestamptz NOT NULL,
  duration_min     int NOT NULL DEFAULT 45,
  mode             text NOT NULL DEFAULT 'video' CHECK (mode IN ('video','phone','in_person')),
  location         text,
  interviewer_user_ids uuid[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled','no_show')),
  score            int CHECK (score IS NULL OR score BETWEEN 1 AND 5),
  recommendation   text CHECK (recommendation IS NULL OR recommendation IN ('strong_hire','hire','no_hire','strong_no_hire')),
  feedback         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS offers (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  candidate_id     uuid NOT NULL,
  designation      text NOT NULL,
  department       text,
  location_code    text,
  grade_code       text,
  annual_ctc_paise bigint NOT NULL CHECK (annual_ctc_paise > 0),
  components       jsonb NOT NULL DEFAULT '{}'::jsonb,     -- monthly components, as compensation_records expects
  structure_code   text,
  joining_date     date NOT NULL,
  valid_until      date NOT NULL,
  employment_type  text NOT NULL DEFAULT 'permanent',
  probation_months int NOT NULL DEFAULT 6 CHECK (probation_months BETWEEN 0 AND 24),
  notice_period_days int NOT NULL DEFAULT 30,
  status           text NOT NULL DEFAULT 'pending_approval'
        CHECK (status IN ('pending_approval','approved','rejected','sent','accepted','declined','withdrawn','expired')),
  approval_request_id uuid,
  letter_document_id uuid,
  sent_at          timestamptz,
  responded_at     timestamptz,
  created_by_user_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates (tenant_id, id)
);
-- one live offer per candidate
CREATE UNIQUE INDEX IF NOT EXISTS offers_live_idx ON offers (tenant_id, candidate_id) WHERE status IN ('pending_approval','approved','sent','accepted');

-- Generated employee numbers come from a per-tenant counter, never MAX() over
-- an RLS-filtered table (a row the caller cannot see is a number handed out twice).
CREATE TABLE IF NOT EXISTS employee_number_counters (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  next      int NOT NULL DEFAULT 1
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['job_requisitions','candidates','interviews','offers','employee_number_counters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
