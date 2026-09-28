-- Place of supply, without which a GST invoice cannot be raised correctly.
--
-- provisionTenant has accepted a stateCode since it was written, and the public
-- signup route documents it in its request example, but nothing ever stored it:
-- the argument was threaded two levels down and dropped. The consequence only
-- appears at invoicing time. GST is split by where the customer is — same state
-- as the supplier is CGST + SGST, anywhere else is IGST — so with no state on
-- file every out-of-state invoice carries the wrong kind of tax, which is most
-- of India for a supplier registered in one state.
--
-- It lives beside the other billing details on the subscription rather than on
-- the tenant, because it is an invoicing fact and it can legitimately differ
-- from where the company's people happen to work.

ALTER TABLE control_plane.subscriptions
  ADD COLUMN IF NOT EXISTS billing_state_code text;

COMMENT ON COLUMN control_plane.subscriptions.billing_state_code IS
  'Place of supply for GST: the two-letter state code of the registered address.';
