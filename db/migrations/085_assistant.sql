-- Grounded assistant (blueprint D). Every question and the intent it resolved
-- to is kept per tenant, so unanswered questions become the next intent and
-- so an answer can be traced to the rows it cited. The text of an answer is
-- not stored — it is re-derivable and may contain personal data.

CREATE TABLE IF NOT EXISTS assistant_queries (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  question     text NOT NULL,
  intent       text,                      -- NULL = not understood
  confidence   numeric(3,2),
  sources      jsonb NOT NULL DEFAULT '[]'::jsonb,
  helpful      boolean,                   -- thumbs up / down
  asked_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS assistant_queries_intent_idx ON assistant_queries (tenant_id, intent, asked_at DESC);

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE assistant_queries ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE assistant_queries FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON assistant_queries';
  -- a person's questions are theirs; HR sees only the aggregate through assistant_gaps()
  EXECUTE format('CREATE POLICY tenant_isolation ON assistant_queries USING (tenant_id = current_tenant() AND (user_id = current_app_user() OR current_user = %L)) WITH CHECK (tenant_id = current_tenant())', current_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON assistant_queries TO %I', app_role);
  EXECUTE format('REVOKE DELETE ON assistant_queries FROM %I', app_role);
END $$;

-- What people ask that the assistant cannot answer, counted, never attributed.
CREATE OR REPLACE FUNCTION assistant_gaps(p_days int)
RETURNS TABLE(sample_question text, asks int, last_asked timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT min(question), count(*)::int, max(asked_at)
    FROM public.assistant_queries
   WHERE tenant_id = current_tenant() AND intent IS NULL AND asked_at > now() - (p_days || ' days')::interval
   GROUP BY lower(regexp_replace(question, '[^a-zA-Z ]', '', 'g'))
  HAVING count(*) >= 2
   ORDER BY 2 DESC LIMIT 50
$$;
REVOKE ALL ON FUNCTION assistant_gaps(int) FROM PUBLIC;
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION assistant_gaps(int) TO %I', app_role);
END $$;
