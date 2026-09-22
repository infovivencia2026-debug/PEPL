-- Trust page (blueprint D). The scheduler writes a heartbeat sample every
-- minute (the readiness probe's verdict); the public trust page derives
-- uptime from them and lists incidents platform operators post. Nothing here
-- is tenant data.

CREATE TABLE IF NOT EXISTS control_plane.uptime_samples (
  sampled_at   timestamptz PRIMARY KEY DEFAULT now(),
  ready        boolean NOT NULL,
  latency_ms   int,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS control_plane.incidents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL,
  resolved_at  timestamptz,
  severity     text NOT NULL CHECK (severity IN ('degraded','partial_outage','major_outage','maintenance')),
  title        text NOT NULL,
  updates      jsonb NOT NULL DEFAULT '[]'::jsonb,       -- [{ at, note }]
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_started_idx ON control_plane.incidents (started_at DESC);

-- Samples older than 400 days are noise; keep the table bounded.
CREATE INDEX IF NOT EXISTS uptime_samples_recent_idx ON control_plane.uptime_samples (sampled_at DESC);
