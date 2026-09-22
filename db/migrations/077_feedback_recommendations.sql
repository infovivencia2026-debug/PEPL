-- 360° feedback and promotion / increment recommendations (blueprint C4).
--
-- 360°: a round is opened for one appraisal (or ad hoc for one person);
-- raters are nominated by relationship (peer, report, manager, stakeholder).
-- Answers are confidential by construction, like survey responses: a row is
-- visible only to its rater; the subject and HR read feedback_aggregate(),
-- which returns per-relationship averages and free text only above the
-- minimum group. The manager's own answer is never anonymous (n=1 by
-- definition) and the aggregate labels it as such rather than hiding it.
--
-- Recommendations: a manager proposes a promotion (new designation / grade)
-- and/or an increment (new CTC or a percentage) off an appraisal; it goes
-- through the approval engine and, on approval, becomes an effective-dated
-- assignment change and a compensation revision — the same two writes HR
-- would have made by hand, with the appraisal as the reason.

CREATE TABLE IF NOT EXISTS feedback_rounds (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  subject_employee_id uuid NOT NULL,
  appraisal_id  uuid,
  title         text NOT NULL,
  questions     jsonb NOT NULL,                       -- [{ id, text, type: 'rating'|'text', scale? }]
  min_group     int  NOT NULL DEFAULT 3 CHECK (min_group >= 2),
  due_on        date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subject_employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, appraisal_id) REFERENCES appraisals (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS feedback_requests (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  round_id      uuid NOT NULL,
  rater_employee_id uuid NOT NULL,
  rater_user_id uuid,                                  -- resolved at nomination; the policy keys on it
  relationship  text NOT NULL CHECK (relationship IN ('manager','peer','report','stakeholder','self')),
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','submitted','declined')),
  answers       jsonb,                                 -- { qid: number | string }
  submitted_at  timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, round_id, rater_employee_id),
  FOREIGN KEY (tenant_id, round_id) REFERENCES feedback_rounds (tenant_id, id),
  FOREIGN KEY (tenant_id, rater_employee_id) REFERENCES employees (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS recommendations (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL,
  appraisal_id  uuid,
  kind          text NOT NULL CHECK (kind IN ('promotion','increment','both')),
  new_designation text,
  new_grade_code  text,
  new_annual_ctc_paise bigint CHECK (new_annual_ctc_paise IS NULL OR new_annual_ctc_paise > 0),
  current_annual_ctc_paise bigint,
  increment_pct numeric(6,2),
  effective_from date NOT NULL,
  justification text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','applied','withdrawn')),
  approval_request_id uuid,
  recommended_by_user_id uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, appraisal_id) REFERENCES appraisals (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS recommendations_one_open_idx ON recommendations (tenant_id, employee_id) WHERE status IN ('pending','approved');

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['feedback_rounds','feedback_requests','recommendations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  EXECUTE format('REVOKE DELETE ON feedback_requests FROM %I', app_role);
END $$;

-- A rater sees and writes only their own request row. Nobody else in the app
-- role can select one; the owner clause is for feedback_aggregate() alone.
DROP POLICY IF EXISTS tenant_isolation ON feedback_requests;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY tenant_isolation ON feedback_requests USING (tenant_id = current_tenant() AND (rater_user_id = current_app_user() OR current_user = %L)) WITH CHECK (tenant_id = current_tenant())', current_user);
END $$;

-- Per relationship: how many were asked, how many answered, the average per
-- rating question, and free text — the last two only when the group reaches
-- min_group. 'manager' and 'self' are single-rater by nature and are reported
-- at n=1, labelled, because they were never anonymous to begin with.
CREATE OR REPLACE FUNCTION feedback_aggregate(p_round uuid)
RETURNS TABLE(relationship text, asked int, answered int, question_id text, avg_value numeric, texts jsonb, withheld boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH rd AS (SELECT min_group FROM public.feedback_rounds WHERE id = p_round AND tenant_id = current_tenant()),
  req AS (SELECT fr.relationship, count(*)::int AS asked, count(*) FILTER (WHERE fr.status = 'submitted')::int AS answered
            FROM public.feedback_requests fr WHERE fr.round_id = p_round AND fr.tenant_id = current_tenant() GROUP BY fr.relationship),
  ans AS (SELECT fr.relationship, q.key AS qid, q.value AS v
            FROM public.feedback_requests fr, jsonb_each(fr.answers) q
           WHERE fr.round_id = p_round AND fr.tenant_id = current_tenant() AND fr.status = 'submitted'),
  g AS (SELECT relationship, qid, count(*)::int AS n,
               avg(CASE WHEN jsonb_typeof(v) = 'number' THEN (v #>> '{}')::numeric END) AS avg_value,
               jsonb_agg(v) FILTER (WHERE jsonb_typeof(v) = 'string') AS texts
          FROM ans GROUP BY relationship, qid)
  SELECT req.relationship, req.asked, req.answered, g.qid,
         CASE WHEN ok THEN round(g.avg_value, 2) END, CASE WHEN ok THEN g.texts END, NOT ok
    FROM req LEFT JOIN g ON g.relationship = req.relationship
    CROSS JOIN LATERAL (SELECT (req.relationship IN ('manager','self') OR req.answered >= (SELECT min_group FROM rd)) AS ok) k
$$;
REVOKE ALL ON FUNCTION feedback_aggregate(uuid) FROM PUBLIC;
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION feedback_aggregate(uuid) TO %I', app_role);
END $$;

-- The nightly reminder runs with no user pinned and so sees no request row;
-- this hands it the ids and rater users of what is still open, nothing more.
CREATE OR REPLACE FUNCTION feedback_pending(p_due_by date)
RETURNS TABLE(request_id uuid, round_id uuid, rater_user_id uuid, due_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT fr.id, r.id, fr.rater_user_id, r.due_on
    FROM public.feedback_requests fr JOIN public.feedback_rounds r ON (r.tenant_id, r.id) = (fr.tenant_id, fr.round_id)
   WHERE fr.tenant_id = current_tenant() AND r.status = 'open' AND fr.status = 'requested' AND fr.rater_user_id IS NOT NULL AND r.due_on <= p_due_by
$$;
REVOKE ALL ON FUNCTION feedback_pending(date) FROM PUBLIC;
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION feedback_pending(date) TO %I', app_role);
END $$;
