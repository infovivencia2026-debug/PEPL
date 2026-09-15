-- A notification can carry documents.
--
-- The payslip email is the first case: the notification IS the email, and an
-- email about a payslip without the payslip attached makes a person log in to
-- find what they were told they had been sent. Document ids, not bytes — the
-- documents module already owns storage, retention and erasure.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS attachment_document_ids uuid[] NOT NULL DEFAULT '{}';
