-- Network benchmarks (blueprint D). OPT-IN. A contributing company's nightly
-- metrics are written to the control plane keyed by a one-way hash of its
-- tenant id, with its segment (organisation type × size band). A company
-- reads its own value against the segment's quartiles, and only when at
-- least MIN_K companies contributed to that segment — below that, nothing is
-- shown, not even a median. Money metrics are deliberately absent.

CREATE TABLE IF NOT EXISTS control_plane.benchmark_samples (
  tenant_hash   text NOT NULL,
  month         text NOT NULL,                 -- YYYY-MM the metrics describe
  segment       text NOT NULL,                 -- e.g. manufacturing:50-199
  metrics       jsonb NOT NULL,                -- { attrition_pct_12m, attendance_pct, avg_late_min, leave_days_per_head, ot_hours_per_head, approval_turnaround_h }
  sampled_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_hash, month)
);
CREATE INDEX IF NOT EXISTS benchmark_samples_segment_idx ON control_plane.benchmark_samples (segment, month);
