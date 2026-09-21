-- Invoices and the money side of a subscription.
--
-- Control-plane tables: written by the superuser connection only (the app
-- role cannot reach control_plane), read by the tenant through a route that
-- filters on its own tenant_id. An invoice is computed at period end from the
-- plan's prices and the active headcount, carries GST, and is either due or
-- settled; dunning moves the subscription to past_due and then suspended by
-- looking at the oldest unpaid one. Payment collection itself (a gateway) is
-- an adapter to add; marking paid is an operator action recorded in
-- platform_audit.
CREATE TABLE IF NOT EXISTS control_plane.invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  number             text NOT NULL UNIQUE,
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  plan_code          text NOT NULL,
  employees          int  NOT NULL CHECK (employees >= 0),
  base_paise         bigint NOT NULL CHECK (base_paise >= 0),
  per_employee_paise bigint NOT NULL CHECK (per_employee_paise >= 0),
  subtotal_paise     bigint NOT NULL CHECK (subtotal_paise >= 0),
  gst_rate           numeric(5,4) NOT NULL DEFAULT 0.18,
  gst_paise          bigint NOT NULL CHECK (gst_paise >= 0),
  total_paise        bigint NOT NULL CHECK (total_paise >= 0),
  status             text NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','void')),
  due_on             date NOT NULL,
  paid_at            timestamptz,
  payment_reference  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start)
);
CREATE INDEX IF NOT EXISTS invoices_tenant_idx ON control_plane.invoices (tenant_id, period_start DESC);

-- A per-tenant running number: INV-<year>-<n>, never derived from MAX() over a filtered view.
CREATE TABLE IF NOT EXISTS control_plane.invoice_counters (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  next      int NOT NULL DEFAULT 1
);

-- The company's GST registration and billing address, for the invoice.
ALTER TABLE control_plane.subscriptions ADD COLUMN IF NOT EXISTS billing_gstin text;
ALTER TABLE control_plane.subscriptions ADD COLUMN IF NOT EXISTS billing_address text;
ALTER TABLE control_plane.subscriptions ADD COLUMN IF NOT EXISTS billing_email text;

-- Statuses dunning moves through. 'trialing' → 'active' on first payment or plan change.
ALTER TABLE control_plane.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE control_plane.subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('trialing','active','past_due','suspended','cancelled'));
