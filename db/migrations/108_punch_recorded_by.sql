-- Who submitted a punch.
--
-- A punch has always said WHOSE it is (employee_id). When a manager or HR punched on someone's
-- behalf it said nothing about who had done it, so a punch that made a person present could not
-- be attributed to anyone -- exactly the record a dispute about attendance needs.
--
-- Nullable, and left NULL for every existing row: the past cannot be reconstructed, and
-- inventing an actor for it would be worse than admitting there is none. New punches always
-- carry it. The column is written on INSERT only; attendance_punches stays append-only.

ALTER TABLE attendance_punches ADD COLUMN IF NOT EXISTS recorded_by_user_id uuid;

COMMENT ON COLUMN attendance_punches.recorded_by_user_id IS
  'The user who submitted this punch. Equals the employee''s own login for a self-punch; the manager or HR user for a punch made on someone''s behalf. NULL for punches recorded before this column existed and for device imports.';
