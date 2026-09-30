-- Evidence tables the runtime role could still rewrite.
--
-- 003 grants SELECT, INSERT, UPDATE and DELETE on every table, and on every future one.
-- Tables that must not be rewritten therefore stay rewritable until a migration revokes
-- the rest, which happened for audit_events, leave_ledger and the others but not for:
--
--   ticket_messages      what a grievance SAID. Nothing in src/ updates or deletes one.
--   login_attempts       the lockout counters. UPDATE/DELETE here lets one compromised
--                        request reset every brute-force limit. Nothing in src/ does either.
--   documents            the application soft-deletes (deleted_at) -- it never removes a row.
--   employee_bank_accounts  superseded or erased in place, never removed.
--
-- The application only ever inserts into the first two, so both privileges go. The last two
-- are UPDATEd on purpose (retire, supersede, erase) so only DELETE goes.

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON ticket_messages, login_attempts FROM %I', app_role);
  EXECUTE format('REVOKE DELETE, TRUNCATE ON documents, employee_bank_accounts FROM %I', app_role);
END $$;
