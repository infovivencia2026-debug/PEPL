-- Tasks. See docs/architecture/field-sales-ops.md §3.
--
-- ONE task primitive serves onboarding, offboarding, asset recovery, document
-- collection and ad-hoc assignment. Building it once generically is why
-- "onboarding" needs no module of its own: it is a template plus an event.

CREATE TABLE IF NOT EXISTS task_templates (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  trigger_event text,                       -- employee.hired | employee.exited | manual
  applies_to    jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'active',
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS task_template_items (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id         uuid NOT NULL,
  title               text NOT NULL,
  description         text,
  assignee_rule       text NOT NULL,        -- manager|hr|it|finance|employee|named_user
  assignee_ref        uuid,
  due_offset_days     int NOT NULL DEFAULT 0,
  sequence            int NOT NULL DEFAULT 1,
  blocks_completion   boolean NOT NULL DEFAULT false,
  requires_attachment boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES task_templates (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS tasks (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  title               text NOT NULL,
  description         text,
  assignee_user_id    uuid,
  assignee_role       text,
  subject_employee_id uuid,                 -- who the task is ABOUT
  source_type         text,                 -- onboarding|offboarding|case|manual
  source_id           uuid,
  template_item_id    uuid,
  priority            text NOT NULL DEFAULT 'normal',
  due_date            date,
  status              text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
  blocks_completion   boolean NOT NULL DEFAULT false,
  completed_by_user_id uuid,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subject_employee_id) REFERENCES employees (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS tasks_inbox_idx
  ON tasks (tenant_id, assignee_user_id, status, due_date);

CREATE TABLE IF NOT EXISTS task_comments (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  id             bigint GENERATED ALWAYS AS IDENTITY,
  task_id        uuid NOT NULL,
  author_user_id uuid NOT NULL,
  body           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id)
);

DO $$
DECLARE t text;
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  FOREACH t IN ARRAY ARRAY['task_templates','task_template_items','tasks','task_comments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, app_role);
  END LOOP;
END $$;
