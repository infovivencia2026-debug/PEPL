-- Groups and resellers (blueprint C6). Control plane, no tenant_id column.
--
-- A GROUP is several companies under one owner (a holding with subsidiaries,
-- a chain of franchises). Its console shows per-company AGGREGATES — counts,
-- totals, scores — never a row from inside a member: the snapshot runs on the
-- app role, in the member's tenant context, in a READ ONLY transaction, and
-- only after that member's own org admin has ACCEPTED the membership.
--
-- A RESELLER is a partner that provisions and bills companies. It sees
-- subscriptions and statuses, never anything inside a company.

CREATE TABLE IF NOT EXISTS control_plane.groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('group','reseller')),
  owner_tenant_id uuid NOT NULL REFERENCES tenants(id),   -- the HQ company (or the reseller's own tenant)
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_tenant_id, name)
);

CREATE TABLE IF NOT EXISTS control_plane.group_members (
  group_id      uuid NOT NULL REFERENCES control_plane.groups(id),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  status        text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','accepted','left')),
  invited_at    timestamptz NOT NULL DEFAULT now(),
  accepted_at   timestamptz,
  accepted_by_user_id uuid,
  left_at       timestamptz,
  PRIMARY KEY (group_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS group_members_tenant_idx ON control_plane.group_members (tenant_id) WHERE status <> 'left';

-- Who at the owner may use the console: users of the owner tenant, named.
CREATE TABLE IF NOT EXISTS control_plane.group_admins (
  group_id      uuid NOT NULL REFERENCES control_plane.groups(id),
  user_id       uuid NOT NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

ALTER TABLE control_plane.subscriptions ADD COLUMN IF NOT EXISTS reseller_group_id uuid REFERENCES control_plane.groups(id);

-- The app role reads nothing here (015): every console read goes through the control connection,
-- and is recorded in platform_audit.
