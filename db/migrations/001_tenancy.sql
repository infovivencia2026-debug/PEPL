-- Wave 1: tenancy core.
-- Conventions enforced here (see docs/architecture/data-model.md §Conventions):
--   * every tenant-owned table carries tenant_id NOT NULL
--   * foreign keys are COMPOSITE (tenant_id, id) so a cross-tenant reference
--     is impossible at the database level, not merely improbable

CREATE TABLE IF NOT EXISTS tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name   text NOT NULL,
  display_name text NOT NULL,
  status       text NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  full_name  text NOT NULL,
  status     text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS employees (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_number text NOT NULL,
  first_name      text NOT NULL,
  last_name       text,
  status          text NOT NULL DEFAULT 'active',
  date_of_joining date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_number)
);

CREATE TABLE IF NOT EXISTS employee_assignments (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL,
  department     text NOT NULL,
  designation    text NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  superseded_at  timestamptz,
  PRIMARY KEY (tenant_id, id),
  -- composite FK: the child's tenant must match the parent's tenant
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS employees_tenant_name_idx
  ON employees (tenant_id, last_name, first_name);
CREATE INDEX IF NOT EXISTS assignments_tenant_employee_idx
  ON employee_assignments (tenant_id, employee_id);
