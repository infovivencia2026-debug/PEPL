-- Tax declarations: what an employee tells payroll about their investments,
-- rent and regime, once per fiscal year.
--
-- Until now TDS was a slab projection on gross with no deductions at all, so
-- every payslip over-deducted for anyone with a PPF, a health policy or a rented
-- flat. The declaration is the input; payroll/chapter-via.ts applies the
-- statutory ceilings; the RESULT is written to payroll_inputs at freeze as a
-- value, so a locked run never depends on a declaration edited afterwards.

CREATE TABLE IF NOT EXISTS tax_declarations (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL,
  fiscal_year   text NOT NULL,                       -- '2026-27'
  regime        text NOT NULL CHECK (regime IN ('old','new')),
  -- Section amounts in paise, rent, metro flag: the Declaration shape in
  -- chapter-via.ts. jsonb because the set of sections is the Act's, not ours.
  declared      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- draft: the employee is still editing. submitted: frozen for payroll to
  -- verify. verified: payroll has seen proofs; this is the one freeze reads.
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','verified','rejected')),
  proof_document_ids uuid[] NOT NULL DEFAULT '{}',
  submitted_at  timestamptz,
  verified_at   timestamptz,
  verified_by_user_id uuid,
  rejection_reason text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  UNIQUE (tenant_id, employee_id, fiscal_year)
);

-- What freeze resolved from the declaration. A VALUE, following the payroll
-- invariant: the engine reads payroll_inputs and nothing else.
ALTER TABLE payroll_inputs
  ADD COLUMN IF NOT EXISTS chapter_via_paise bigint NOT NULL DEFAULT 0;

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE 'ALTER TABLE tax_declarations ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE tax_declarations FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON tax_declarations';
  EXECUTE 'CREATE POLICY tenant_isolation ON tax_declarations
             USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON tax_declarations TO %I', app_role);
  -- A declaration is superseded by editing it, never deleted: the one payroll
  -- verified in October has to be reconstructible in March.
  EXECUTE format('REVOKE DELETE ON tax_declarations FROM %I', app_role);
END $$;
