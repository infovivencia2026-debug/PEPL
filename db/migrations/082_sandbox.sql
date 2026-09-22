-- Sandbox tenants (blueprint D). A sandbox is a full tenant, linked to the
-- real company that owns it, filled with sample data and dated to expire.
-- Nothing leaves a sandbox: the email, WhatsApp and webhook jobs skip it.
-- Expiry purges it.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_sandbox boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sandbox_of uuid REFERENCES tenants(id);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sandbox_expires_on date;
CREATE INDEX IF NOT EXISTS tenants_sandbox_idx ON tenants (sandbox_of) WHERE is_sandbox;
