-- Company activity log. See docs/architecture/activity-log.md.
--
-- One spine every module writes to, alongside the module-specific append-only
-- tables. The spine answers "what happened across the company"; the module
-- tables answer "what exactly changed, in domain terms".

CREATE TABLE IF NOT EXISTS audit_events (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),

  actor_user_id uuid,
  actor_type    text NOT NULL DEFAULT 'user'
                CHECK (actor_type IN ('user','system','integration','support','anonymous')),
  actor_label   text,                    -- name+role AT THE TIME; survives deletion

  action        text NOT NULL,
  category      text NOT NULL,
  severity      text NOT NULL DEFAULT 'info'
                CHECK (severity IN ('info','notice','warning','critical')),

  entity_type   text NOT NULL,
  entity_id     uuid,
  entity_label  text,
  subject_employee_id uuid,              -- whose record this concerns; drives visibility

  before        jsonb,
  after         jsonb,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason        text,

  request_id    uuid,
  ip            inet,
  source        text NOT NULL DEFAULT 'web',

  -- tamper evidence: a hash chain per tenant
  prev_hash     bytea,
  row_hash      bytea,

  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS audit_recent_idx     ON audit_events (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_entity_idx     ON audit_events (tenant_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx      ON audit_events (tenant_id, actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_subject_idx    ON audit_events (tenant_id, subject_employee_id, occurred_at DESC);

-- Chains the row to its predecessor. Any retrospective edit or deletion breaks
-- the chain and is detectable by re-walking it: "trust the operator" becomes
-- "verify", for one hash per insert.
CREATE OR REPLACE FUNCTION audit_chain_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prev bytea;
BEGIN
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

DROP TRIGGER IF EXISTS audit_chain ON audit_events;
CREATE TRIGGER audit_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_chain_row();

-- Daily seal, written by the control plane, so a break is provable even if the
-- whole application row set is rewritten.
CREATE TABLE IF NOT EXISTS control_plane.audit_seals (
  tenant_id     uuid NOT NULL,
  sealed_date   date NOT NULL,
  last_event_id bigint NOT NULL,
  tip_hash      bytea NOT NULL,
  sealed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sealed_date)
);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_events;
CREATE POLICY tenant_isolation ON audit_events
  USING      (tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());

DO $$
DECLARE app_role text := coalesce(nullif(current_setting('pepl.app_role', true), ''), 'pepl_app');
BEGIN
  EXECUTE format('GRANT SELECT, INSERT ON audit_events TO %I', app_role);
  -- Append-only, enforced by grant rather than by convention: the application
  -- role physically cannot rewrite history.
  EXECUTE format('REVOKE UPDATE, DELETE ON audit_events FROM %I', app_role);
  EXECUTE format('REVOKE ALL ON control_plane.audit_seals FROM %I', app_role);
END $$;
