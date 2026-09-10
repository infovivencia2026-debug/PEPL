-- Chat and mail were sellable by nobody.
--
-- Both settings declare an entitlement (chat.enabled -> 'chat',
-- mail.enabled -> 'mail'), and the entitlement layer is the outermost gate: a
-- tenant setting can never widen it. No plan in the catalogue granted either
-- feature, so every tenant on every plan resolved both to false, permanently.
-- The modules were built, tested, routed and documented, and unreachable.
--
-- The tiering matches the existing shape: starter is payroll-free and stays
-- lean, growth gets team chat because that is the feature a growing team asks
-- for first, and mail — which carries customer credentials and an outbound
-- reputation — is a professional concern.

UPDATE control_plane.plans
   SET features = features || '{"chat":true,"mail":true}'::jsonb
 WHERE code IN ('professional', 'trial');

UPDATE control_plane.plans
   SET features = features || '{"chat":true,"mail":false}'::jsonb
 WHERE code = 'growth';

UPDATE control_plane.plans
   SET features = features || '{"chat":false,"mail":false}'::jsonb
 WHERE code = 'starter';

-- Existing tenants keep whatever their plan now says. tenant_entitlements is a
-- PROJECTION of the plan, so it is re-derived rather than edited by hand — but
-- nothing re-projects on its own, and a customer already on professional should
-- not have to wait for a subscription change to see a feature they are paying
-- for.
UPDATE tenant_entitlements e
   SET features = e.features || (p.features - 'payroll' - 'helpdesk' - 'incentives')
  FROM control_plane.plans p
 WHERE p.code = e.plan_code;
