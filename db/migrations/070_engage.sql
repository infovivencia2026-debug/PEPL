-- Engagement (blueprint B3): policies people must read and sign, surveys
-- that are anonymous by construction, and a celebrations feed.
--
-- Survey anonymity is in the POLICY, not the service: an individual response
-- row is visible to nobody but its author (and only on a non-anonymous
-- survey); everyone else reads the aggregate function, which refuses to
-- answer for fewer than the survey's minimum group. A forgotten WHERE clause
-- cannot leak a person's answer because the row is not there to be selected.

CREATE TABLE IF NOT EXISTS policies (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  code          text NOT NULL,                       -- POSH, CODE_OF_CONDUCT, IT_SECURITY, LEAVE, ...
  title         text NOT NULL,
  version       int  NOT NULL DEFAULT 1,
  body          text,                                -- markdown; or a document
  document_id   uuid,
  requires_acknowledgement boolean NOT NULL DEFAULT true,
  applies_to    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { departments: [], locations: [] } ; {} = everyone
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  published_at  timestamptz,
  due_days      int  NOT NULL DEFAULT 14,
  created_by_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code, version)
);

CREATE TABLE IF NOT EXISTS policy_acknowledgements (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  policy_id     uuid NOT NULL,
  employee_id   uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  ip            inet,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, policy_id, employee_id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES policies (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS surveys (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  kind          text NOT NULL DEFAULT 'pulse' CHECK (kind IN ('pulse','enps','custom','suggestion_box')),
  questions     jsonb NOT NULL,                      -- [{ id, text, type: scale|nps|text|choice, options?[] }]
  anonymous     boolean NOT NULL DEFAULT true,
  min_group     int  NOT NULL DEFAULT 5,             -- aggregates below this many responses are withheld
  audience      jsonb NOT NULL DEFAULT '{}'::jsonb,
  opens_at      timestamptz NOT NULL DEFAULT now(),
  closes_at     timestamptz,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  created_by_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

-- WHO has responded (no double answers; response rate) - separate from WHAT they said.
CREATE TABLE IF NOT EXISTS survey_participation (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  survey_id   uuid NOT NULL,
  employee_id uuid NOT NULL,
  responded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, survey_id, employee_id),
  FOREIGN KEY (tenant_id, survey_id) REFERENCES surveys (tenant_id, id) ON DELETE CASCADE
);

-- The answers. No employee id on an anonymous survey: only a segment, so
-- aggregates by department are possible without a path back to the person.
CREATE TABLE IF NOT EXISTS survey_responses (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  survey_id   uuid NOT NULL,
  author_user_id uuid,                               -- set only on a NON-anonymous survey
  segment     jsonb NOT NULL DEFAULT '{}'::jsonb,    -- { department, location } copied at submit time
  answers     jsonb NOT NULL,                        -- { [questionId]: value }
  submitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, survey_id) REFERENCES surveys (tenant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['policies','policy_acknowledgements','surveys','survey_participation','survey_responses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
  EXECUTE format('REVOKE UPDATE, DELETE ON policy_acknowledgements FROM %I', app_role);
  EXECUTE format('REVOKE UPDATE ON survey_responses FROM %I', app_role);
END $$;

-- Individual responses: readable only by their author, which only a
-- non-anonymous survey records. On an anonymous survey NO session can select
-- a row; survey_aggregate() is the only way in.
-- The owner clause exists for survey_aggregate() alone: FORCE ROW LEVEL SECURITY
-- binds the owner too, and the aggregate runs as the owner. The app role never
-- matches it.
DROP POLICY IF EXISTS tenant_isolation ON survey_responses;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY tenant_isolation ON survey_responses USING (tenant_id = current_tenant() AND ((author_user_id IS NOT NULL AND author_user_id = current_app_user()) OR current_user = %L)) WITH CHECK (tenant_id = current_tenant())', current_user);
END $$;

-- Aggregation runs as the owner (SECURITY DEFINER) so it can read every row of
-- the CALLER'S tenant, and returns only counts, averages, distributions and
-- (above the minimum group) free-text answers. Never a row.
CREATE OR REPLACE FUNCTION survey_aggregate(p_survey uuid, p_segment_key text)
RETURNS TABLE(segment text, question_id text, responses int, avg_value numeric, distribution jsonb, texts jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH s AS (SELECT min_group FROM public.surveys WHERE id = p_survey AND tenant_id = current_tenant()),
  r AS (
    SELECT coalesce(CASE WHEN p_segment_key IS NULL THEN 'all' ELSE sr.segment ->> p_segment_key END, 'unknown') AS seg, q.key AS qid, q.value AS v
      FROM public.survey_responses sr, jsonb_each(sr.answers) q
     WHERE sr.survey_id = p_survey AND sr.tenant_id = current_tenant()
  ),
  g AS (
    SELECT seg, qid, count(*)::int AS n,
           avg(CASE WHEN jsonb_typeof(v) = 'number' THEN (v #>> '{}')::numeric END) AS avg_value,
           (SELECT jsonb_object_agg(k, c) FROM (SELECT (r2.v #>> '{}') AS k, count(*) AS c FROM r r2 WHERE r2.seg = r.seg AND r2.qid = r.qid AND jsonb_typeof(r2.v) <> 'string' GROUP BY 1) x) AS distribution,
           jsonb_agg(v) FILTER (WHERE jsonb_typeof(v) = 'string') AS texts
      FROM r GROUP BY seg, qid
  )
  SELECT g.seg, g.qid, g.n, round(g.avg_value, 2), g.distribution, g.texts
    FROM g WHERE g.n >= (SELECT min_group FROM s)
$$;
REVOKE ALL ON FUNCTION survey_aggregate(uuid, text) FROM PUBLIC;
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION survey_aggregate(uuid, text) TO %I', app_role);
END $$;
