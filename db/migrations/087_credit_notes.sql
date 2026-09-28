-- Credit notes: the only lawful way to reverse an invoice that has been paid.
--
-- `voidInvoice` handles the easy case — an invoice raised in error, before the
-- money arrives, keeps its number and stops being chased. Once a customer has
-- paid, that door is closed: their books and ours both record a settled
-- invoice, and quietly voiding it leaves the two disagreeing about money that
-- actually moved. Under GST the instrument is a credit note, which is its own
-- document with its own number series, referencing the invoice it reduces.
--
-- Modelled on invoices deliberately: same shape, same counter discipline (a
-- running number per tenant, never MAX() over a filtered view), same GST
-- columns so the CGST/SGST-vs-IGST split is computed from the same place of
-- supply the original used. A credit note is never partially applied twice —
-- the sum of notes against an invoice cannot exceed it, which the service
-- enforces because it needs to read the other rows to know.

CREATE TABLE IF NOT EXISTS control_plane.credit_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  invoice_id     uuid NOT NULL REFERENCES control_plane.invoices(id),
  number         text NOT NULL UNIQUE,
  reason         text NOT NULL,
  subtotal_paise bigint NOT NULL CHECK (subtotal_paise > 0),
  gst_rate       numeric(5,4) NOT NULL DEFAULT 0.18,
  gst_paise      bigint NOT NULL CHECK (gst_paise >= 0),
  total_paise    bigint NOT NULL CHECK (total_paise > 0),
  issued_on      date NOT NULL DEFAULT CURRENT_DATE,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_notes_tenant_idx
  ON control_plane.credit_notes (tenant_id, issued_on DESC);
CREATE INDEX IF NOT EXISTS credit_notes_invoice_idx
  ON control_plane.credit_notes (invoice_id);

-- Its own series, so a credit note number can never collide with an invoice
-- number and a gap in either sequence means exactly one thing.
CREATE TABLE IF NOT EXISTS control_plane.credit_note_counters (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  next      int NOT NULL DEFAULT 1
);

COMMENT ON TABLE control_plane.credit_notes IS
  'Reverses part or all of a PAID invoice. An unpaid one is voided instead.';
