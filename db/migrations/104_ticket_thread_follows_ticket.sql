-- What was SAID on a confidential ticket is as confidential as the ticket.
--
-- 011 gave `tickets` a policy that hides a grievance from everyone but the person who
-- raised it and the named committee, "in a list, a count, a search or an export, because
-- the rows simply are not returned". `ticket_messages` and `ticket_events` kept the plain
-- tenant policy, so the ticket was hidden and its whole thread was not: any query that
-- reached the message table directly -- a new report, a search, a job -- returned a
-- complaint's text to anyone in the company.
--
-- Both now require the parent ticket to be VISIBLE. The subquery runs under the caller's
-- own rights, so it is subject to the `tickets` policy: whoever cannot see the ticket sees
-- none of its messages or events, and the rule lives in one place (the tickets policy)
-- rather than being copied. WITH CHECK is the same, so a user cannot write onto a ticket
-- they cannot see either.
--
-- tenant_id = current_tenant() stays first: gate:rls requires it, and a missing tenant
-- context still yields zero rows.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_messages','ticket_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %1$I
        USING (
          tenant_id = current_tenant()
          AND EXISTS (SELECT 1 FROM tickets k
                       WHERE k.tenant_id = %1$I.tenant_id AND k.id = %1$I.ticket_id)
        )
        WITH CHECK (
          tenant_id = current_tenant()
          AND EXISTS (SELECT 1 FROM tickets k
                       WHERE k.tenant_id = %1$I.tenant_id AND k.id = %1$I.ticket_id)
        )$p$, t);
  END LOOP;
END $$;
