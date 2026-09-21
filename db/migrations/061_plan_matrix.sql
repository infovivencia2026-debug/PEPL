-- The plan matrix from the platform blueprint (§9). Every row of the matrix is
-- exactly one entitlement key; changing a tier is an edit here plus a
-- re-projection (npm run job control.reproject_entitlements), never a deploy.
--
-- Until now expenses, timesheets, recruitment and performance had an
-- `enabled` switch but no entitlement, so every plan — including Starter —
-- got them free and nobody could sell or withhold them.

UPDATE control_plane.plans SET features = features || '{"expenses":false,"timesheets":false,"recruitment":false,"performance":false,"assets":false,"learning":false,"surveys":false,"integrations":false,"branding":false}'::jsonb
 WHERE code = 'starter';
UPDATE control_plane.plans SET features = features || '{"expenses":true,"timesheets":true,"recruitment":false,"performance":false,"assets":false,"learning":false,"surveys":false,"integrations":false,"branding":false}'::jsonb
 WHERE code = 'growth';
UPDATE control_plane.plans SET features = features || '{"expenses":true,"timesheets":true,"recruitment":true,"performance":true,"assets":true,"learning":true,"surveys":true,"integrations":true,"branding":false}'::jsonb
 WHERE code IN ('professional', 'trial');

INSERT INTO control_plane.plans (code, name, base_price_paise, per_employee_price_paise, features, limits)
VALUES ('enterprise', 'Enterprise', 3000000, 12000,
  '{"payroll":true,"helpdesk":true,"incentives":true,"chat":true,"mail":true,"expenses":true,"timesheets":true,"recruitment":true,"performance":true,"assets":true,"learning":true,"surveys":true,"integrations":true,"branding":true}'::jsonb,
  '{"employees":10000,"storage_gb":1000}'::jsonb)
ON CONFLICT (code) DO NOTHING;
