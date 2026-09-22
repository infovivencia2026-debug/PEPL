-- The organisation-type preset a tenant was provisioned with (blueprint §6).
-- Informational: after signup it is ordinary configuration; this records the
-- starting point for support and for re-applying to a new department.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS organisation_type text;
