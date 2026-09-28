-- Fixes the lock added in 092, which did not exist.
--
-- 092 called:
--
--   pg_advisory_xact_lock('audit_events'::regclass::oid::bigint, hashtext(...))
--
-- `hashtext` returns int4 and the cast produced int8, so the call matched
-- neither the one-key (int8) nor the two-key (int4, int4) overload and every
-- insert into audit_events failed with
-- "function pg_advisory_xact_lock(bigint, integer) does not exist".
--
-- Worth recording how that got through: the concurrency test written alongside
-- 092 DID fail, and the failure was read as "the chain is still forking" rather
-- than "the trigger is throwing". The test was right and the reading was wrong.
-- Two int4 keys, as the two-key form requires.

CREATE OR REPLACE FUNCTION audit_chain_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prev bytea;
BEGIN
  -- Serialises the append per tenant for the length of the transaction: a hash
  -- chain is one line, so it cannot be appended to in parallel. Different
  -- companies hash to different keys and never contend.
  PERFORM pg_advisory_xact_lock(hashtext('audit_events'), hashtext(NEW.tenant_id::text));

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
