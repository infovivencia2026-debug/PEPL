-- Billing a plan change: one invoice per period, and the period bills at the plan it started on.
--
-- 1. `kind` separates a period's own invoice from a plan-change top-up. Both were keyed
--    (tenant_id, period_start), with the top-up's period_start = the day of the switch. Switch
--    on the first day of a period and the top-up owned the key, so the period's real invoice
--    was `ON CONFLICT DO NOTHING` -- silently never written. A second upgrade on the same
--    day failed outright, after the plan had already changed.
--
--    Idempotence per period is what the unique key was FOR, so it stays -- for periods only.
--    A top-up is its own invoice with its own number and there can be several.
--
-- 2. `period_plan_code` is the plan the CURRENT period is billed at, when that differs from
--    the plan now in force. NULL (every existing row) means "the current plan". The period
--    invoice used to be written at the plan in force at the period's END, so an upgrade paid
--    the top-up AND the new price for the whole period, and a downgrade was retroactive --
--    against docs/proration ("a downgrade takes effect at the next period"). Set when a
--    paying customer switches, cleared when the period rolls forward.

ALTER TABLE control_plane.invoices
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'period' CHECK (kind IN ('period', 'proration'));

ALTER TABLE control_plane.invoices DROP CONSTRAINT IF EXISTS invoices_tenant_id_period_start_key;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_period_invoice
  ON control_plane.invoices (tenant_id, period_start) WHERE kind = 'period';

ALTER TABLE control_plane.subscriptions ADD COLUMN IF NOT EXISTS period_plan_code text;

-- `period_covered_plan_code` is the priciest plan already PAID FOR through the rest of the
-- period (by a top-up). Without it, upgrade -> downgrade -> upgrade inside one period would
-- charge the same difference twice. NULL means nothing has been topped up: the plan in force.
ALTER TABLE control_plane.subscriptions ADD COLUMN IF NOT EXISTS period_covered_plan_code text;

COMMENT ON COLUMN control_plane.invoices.kind IS
  'period: the invoice for a billing period (one per tenant and period_start). proration: a mid-period upgrade top-up.';
COMMENT ON COLUMN control_plane.subscriptions.period_covered_plan_code IS
  'Priciest plan already paid for through the rest of the current period (a top-up). NULL = the plan in force.';
COMMENT ON COLUMN control_plane.subscriptions.period_plan_code IS
  'Plan the current period is billed at, when it differs from plan_code (a switch mid-period). NULL = plan_code.';
