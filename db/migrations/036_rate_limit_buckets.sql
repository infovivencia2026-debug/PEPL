-- Rate-limit counters shared across API instances.
--
-- The in-process limiter is exact for one process and wrong for two: behind a
-- balancer each instance keeps its own count, so the limit doubles and a
-- lockout depends on which instance the request lands on. This table holds
-- one row per (key) with a fixed window, and one UPSERT per request either
-- increments the current window or opens a new one.
--
-- Global, like login_attempts, and for the same reason: the key is an IP or a
-- hashed token, known before any tenant is. It holds no tenant data.
CREATE UNLOGGED TABLE IF NOT EXISTS rate_limit_buckets (
  key          text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count        int NOT NULL
);
-- UNLOGGED: a counter that survives a crash is not worth a WAL write per request.

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_buckets TO %I', app_role);
END $$;
