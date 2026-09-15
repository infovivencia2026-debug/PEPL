-- Data-subject rights (DPDP Act 2023), and a retention bug it exposed.
--
-- 007 made attendance_punches immutable for the runtime role — correct, a
-- punch is evidence — and the retention job written later UPDATEs the two
-- coordinate columns to age them out. It has answered "permission denied for
-- table attendance_punches" on every tenant, every night, since. The job
-- reported it in its output and nothing read the output.
--
-- Column-level grant: the coordinates may be blanked, nothing else on the row
-- may change. Both the retention job and erasure use exactly this.
DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT UPDATE (geo_lat, geo_lng) ON attendance_punches TO %I', app_role);
END $$;

-- Erasure is anonymisation in place; this marks that it happened, so the row
-- is never anonymised twice and a screen can say why the name is "Erased".
ALTER TABLE employees ADD COLUMN IF NOT EXISTS erased_at timestamptz;

-- An erased login must stay unique and must never authenticate. The status
-- value is new; nothing else reads it as anything but "not active".
ALTER TABLE app_users ALTER COLUMN password_hash DROP NOT NULL;
