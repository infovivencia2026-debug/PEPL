-- Invoice and credit-note numbering that fits the rule it has to fit.
--
-- CGST Rule 46(b): the serial number must be consecutive, unique for a
-- FINANCIAL YEAR, made only of letters, digits, '-' and '/', and
-- **not more than sixteen characters**.
--
-- The old scheme produced `INV-2026-ABCDEF-00001` -- twenty-one characters, so
-- every invoice PEPL issued breached the length limit. It also labelled the
-- series with a CALENDAR year taken from the period end, which is not the unit
-- the rule is about: April 2027 and March 2027 fall in different financial
-- years and would have carried the same "2027".
--
-- The new form is `INV/26-27/00001` (15) and `CRN/26-27/00001` (15), a single
-- supplier-wide series per kind per financial year. One series is simpler to
-- defend than one per customer, and PEPL is one supplier.
--
-- Safe to change now precisely because no invoice has ever been issued in
-- production. It would not be safe later: an issued invoice's number is a
-- record, and a series that restarts or changes shape mid-year is the thing
-- the rule exists to prevent.

CREATE TABLE IF NOT EXISTS control_plane.document_series (
  -- 'invoice' | 'credit_note'
  kind text NOT NULL,
  -- '26-27' for 1 Apr 2026 - 31 Mar 2027
  fy   text NOT NULL,
  next integer NOT NULL DEFAULT 1 CHECK (next > 0),
  PRIMARY KEY (kind, fy)
);

COMMENT ON TABLE control_plane.document_series IS
  'Consecutive numbering per document kind per financial year. CGST Rule 46(b): 16 characters, unique within the financial year.';

-- The per-tenant counters are left in place rather than dropped. They hold what
-- was handed out under the old scheme, and on a deployment that HAS issued
-- invoices that history is the only way to explain a number a customer is
-- holding. They are no longer written to.
COMMENT ON TABLE control_plane.invoice_counters IS
  'SUPERSEDED by control_plane.document_series (096). Kept for the numbers already issued.';
COMMENT ON TABLE control_plane.credit_note_counters IS
  'SUPERSEDED by control_plane.document_series (096). Kept for the numbers already issued.';
