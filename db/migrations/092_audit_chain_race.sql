-- The audit chain forked under concurrency, and said "tampering" when it did.
--
-- The trigger read the tenant's current tip and pointed the new row at it:
--
--   SELECT row_hash INTO prev FROM audit_events
--    WHERE tenant_id = NEW.tenant_id ORDER BY id DESC LIMIT 1;
--
-- Under READ COMMITTED two transactions emitting for the same tenant at the
-- same time both read the same tip and both wrote themselves as its successor.
-- Nothing serialised them, and nothing failed: the chain simply forked, and
-- `verifyChain` and `gate:launch` reported it later as a broken link. Found in
-- a real database as three consecutive rows sharing one prev_hash, and a row
-- whose predecessor had a HIGHER id than itself.
--
-- That is the worst shape a security control can take. The chain exists to
-- turn "trust the operator" into "verify", and a check that reports tampering
-- when nobody tampered trains people to dismiss it — so the first real
-- tampering is dismissed too.
--
-- A hash chain is inherently serial: you cannot append in parallel and still
-- have one line. So the append is serialised per tenant, with a transaction
-- advisory lock keyed on the audit table and the tenant. Concurrent emits for
-- DIFFERENT companies never contend; two for the same company queue behind
-- each other for the length of one insert.
--
-- Chosen over the alternatives deliberately:
--   - `FOR UPDATE` on the tip row does not help: the competing transaction is
--     INSERTING a new row, not updating the one you locked.
--   - A chain-head table would work and matches the counter-table pattern used
--     for invoice numbers, but it adds a table and a second write per event to
--     buy the same serialisation this gets for nothing.

CREATE OR REPLACE FUNCTION audit_chain_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prev bytea;
BEGIN
  -- Held until the transaction ends, so the tip cannot move between the read
  -- below and this row landing. Keyed per tenant: one company's audit traffic
  -- never waits on another's.
  PERFORM pg_advisory_xact_lock(
    'audit_events'::regclass::oid::bigint,
    hashtext(NEW.tenant_id::text)
  );

  SELECT row_hash INTO prev FROM audit_events
   WHERE tenant_id = NEW.tenant_id ORDER BY id DESC LIMIT 1;

  NEW.prev_hash := prev;
  NEW.row_hash := digest(
    coalesce(encode(prev, 'hex'), '') ||
    NEW.tenant_id::text || NEW.action || NEW.entity_type ||
    coalesce(NEW.entity_id::text, '') || coalesce(NEW.actor_user_id::text, '') ||
    coalesce(NEW.before::text, '') || coalesce(NEW.after::text, '') ||
    NEW.occurred_at::text,
    'sha256');
  RETURN NEW;
END $$;
