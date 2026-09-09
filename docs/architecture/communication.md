# PEPL — Internal communication architecture

**Scope:** chat, announcements and notifications. The mailbox is specified separately in [mail.md](mail.md), which supersedes §5 here.

Covers four things that are routinely conflated and must not be:

| # | Surface | Model | Real-time? |
|---|---|---|---|
| 1 | **Chat** — WhatsApp-style DMs and groups | Conversation + message stream | Yes |
| 2 | **Mailbox** — Outlook-style internal mail | Envelope + folder + thread | No (near-real-time) |
| 3 | **Announcements** — company broadcast | Publication + acknowledgement | No |
| 4 | **Notifications** — system events | Already specified in `api-boundaries.md` | Push |

They share a substrate (identity, attachments, search, retention, push) but they are **not the same feature**, and building chat and mail on one "messages" table produces something that is bad at both. Chat optimises for a fast append-only stream with delivery state per participant. Mail optimises for addressing, foldering, threading and long-term retrieval.

---

## 1. Sizing, stated honestly

A WhatsApp-grade chat system — real-time delivery, groups, media, receipts, presence, offline sync, push on two mobile platforms, search — is **a subsystem of comparable size to the rest of the platform combined**. It is not a module added in a sprint, and it is scheduled accordingly (wave 7).

That is not an argument against it. Internal communication inside the HRMS has a real justification that Slack and WhatsApp cannot match: **the employee directory, org chart, roles and lifecycle are already here**. Groups build themselves from departments. A leaver loses access automatically. An HR dispute has a retained, exportable record. Companies currently run employee comms on personal WhatsApp, where the company owns nothing and can retain nothing — that is the actual problem worth solving.

It is an argument about **sequencing and build-vs-buy**, addressed in §9 and §10.

---

## 2. Tenant isolation — the highest-risk surface in the product

A cross-tenant leak in payroll exposes numbers. A cross-tenant leak in messaging exposes conversations. Messaging is the highest-consequence isolation surface PEPL will have, and it is the one where the standard architecture (a WebSocket fan-out keyed by room id) most easily gets it wrong.

Rules:

1. Every conversation, message, attachment, mailbox and folder is `tenant_id`-scoped under RLS with `FORCE`, exactly as `tenancy-security.md` §1 requires.
2. **A conversation may never contain participants from two tenants.** Enforced by a composite foreign key `(tenant_id, employee_id)` on the participant table, plus a check on insert. Cross-company chat is not a feature; if it ever becomes one it will be a deliberate, separately designed bridge.
3. **WebSocket subscription topics are namespaced by tenant**: `t:{tenant_id}:c:{conversation_id}`. A conversation id alone is never a subscription key. A socket authenticates once, resolves its tenant, and can subscribe only within that namespace — asserted server-side on every subscribe, never trusted from the client.
4. Attachment object keys are `t/{tenant_id}/msg/{conversation_id}/{uuid}`, served only by presigned URL after a participant check.
5. The cross-tenant test suite gains a messaging section: tenant A cannot subscribe to, read, search, or attach into anything of tenant B's, and A's socket never receives a B event under load.

---

## 3. Chat data model

```sql
CREATE TYPE conversation_kind AS ENUM ('dm','group','announcement','support');

CREATE TABLE conversations (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  kind conversation_kind NOT NULL,
  title text,                          -- null for DMs, derived from participants
  avatar_object_key text,
  created_by_user_id uuid,
  -- auto-membership: group mirrors an org unit and updates as people move
  auto_scope_type text,                -- department | location | designation | all
  auto_scope_id uuid,
  is_readonly boolean NOT NULL DEFAULT false,   -- broadcast groups
  last_message_at timestamptz,
  status text NOT NULL DEFAULT 'active',        -- active | archived
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ON conversations (tenant_id, last_message_at DESC);

CREATE TABLE conversation_participants (
  tenant_id uuid NOT NULL, conversation_id uuid NOT NULL, user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member',          -- owner | admin | member
  joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz,
  muted_until timestamptz, is_pinned boolean NOT NULL DEFAULT false,
  last_read_message_id bigint,                  -- drives unread counts cheaply
  notification_pref text NOT NULL DEFAULT 'all',-- all | mentions | none
  PRIMARY KEY (tenant_id, conversation_id, user_id)
);

CREATE TABLE messages (
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,       -- monotonic; ordering + cursor
  client_message_id text NOT NULL,              -- idempotency for offline send
  sender_user_id uuid,                          -- null = system message
  body text,
  content_type text NOT NULL DEFAULT 'text',    -- text|image|file|audio|video
                                                -- |system|poll|hrms_object
  reply_to_message_id bigint,
  forwarded_from_message_id bigint,
  mentions uuid[] NOT NULL DEFAULT '{}',
  hrms_ref jsonb,             -- {"type":"leave_request","id":"..."} — inline HR objects
  edited_at timestamptz,
  deleted_at timestamptz, deleted_by_user_id uuid,  -- soft; retention governs purge
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id, id),
  UNIQUE (tenant_id, conversation_id, client_message_id)
) PARTITION BY RANGE (sent_at);
-- monthly partitions; retention drops whole partitions rather than deleting rows

CREATE TABLE message_attachments (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL, message_id bigint NOT NULL,
  object_key text NOT NULL, file_name text NOT NULL,
  mime_type text NOT NULL, size_bytes bigint NOT NULL,
  width int, height int, duration_ms int,       -- media metadata
  thumbnail_object_key text,
  checksum_sha256 text NOT NULL,
  scan_status text NOT NULL DEFAULT 'pending',  -- pending|clean|infected|skipped
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE message_receipts (
  tenant_id uuid NOT NULL, conversation_id uuid NOT NULL,
  message_id bigint NOT NULL, user_id uuid NOT NULL,
  delivered_at timestamptz, read_at timestamptz,
  PRIMARY KEY (tenant_id, conversation_id, message_id, user_id)
);

CREATE TABLE message_reactions (
  tenant_id uuid NOT NULL, conversation_id uuid NOT NULL,
  message_id bigint NOT NULL, user_id uuid NOT NULL,
  emoji text NOT NULL,                          -- unicode, stored as-is
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id, message_id, user_id, emoji)
);
```

### Notes on the shape

- **`message_receipts` is the scaling trap.** A 300-member group × 200 messages/day = 60,000 receipt rows/day per group. Mitigation: store per-participant `last_read_message_id` on `conversation_participants` for read state (one row per member, updated in place), and write per-message receipt rows **only for DMs and groups below a configurable size**, where WhatsApp-style double-ticks are actually expected. Above that threshold the UI shows a read count, computed from the watermark.
- **Partitioned by month** so retention (§8) drops partitions instead of running mass deletes on the largest table in the system.
- **`hrms_ref`** is the feature that justifies chat living inside PEPL: a leave request, payslip, task or employee card rendered inline in a conversation, with permissions checked at render time — not a screenshot.
- **Auto-membership groups** (`auto_scope_*`) rebuild from `employee_assignments`, so a transfer or an exit changes group membership automatically. This is the org-chart advantage no external chat tool has.

### Emoji

Unicode stored directly in `body` and `emoji`; the database is UTF-8 and needs nothing special. Custom/company emoji are a later `custom_emoji` table with an object key. Reactions are a distinct table, not parsed from message text.

---

## 4. Real-time delivery

```
Client (web WS / mobile WS)
   │  connect + auth (short-lived token, NOT the session cookie)
   ▼
WS Gateway (stateless, N instances)
   │  resolve tenant → subscribe only within t:{tenant}:*
   ▼
Redis Pub/Sub  ── fan-out across gateway instances
   ▲
   │  publish on commit
API (message write) ──► Postgres (durable, ordered by identity)
                    └─► outbox row ──► publisher
```

Key properties:

- **Postgres is the source of truth; Redis is transport only.** A dropped pub/sub message is recoverable because the client syncs by cursor (§5). Never treat the broker as the store.
- **Transactional outbox**: the message row and an outbox row commit together; a publisher relays to Redis. This removes the "saved but never delivered" and "delivered but never saved" failure pairs.
- **Ordering** is per conversation, by the monotonic `id`. Clients never order by timestamp — clocks are unreliable, especially on mobile.
- **Idempotency**: `client_message_id` makes a retried send a no-op, which is what makes offline queueing safe.
- **Presence and typing** are Redis-only, TTL'd, never persisted. They are the highest-volume, lowest-value events; persisting them is a common and expensive mistake.
- **Push**: FCM/APNs for offline recipients, with a per-conversation notification preference and a mute window. Notification bodies respect risk tiers — a payroll-related message shows "New message" rather than content on a lock screen, controlled by a tenant setting.

### Sync protocol

```
GET /conversations?updated_since={cursor}
GET /conversations/{id}/messages?after={message_id}&limit=50   → backfill
WS  message.new | message.edited | message.deleted | receipt.updated
    | reaction.added | conversation.updated | presence.changed
```

A client that has been offline for a week reconnects, pulls changed conversations, then backfills each by cursor. There is no "replay the socket" path — the socket is for the live tail only.

---

## 5. Outlook-style mailbox

**This is a different data model from chat and must not share the `messages` table.** Mail is addressed (To/Cc/Bcc), foldered, threaded, and retained for years; chat is a stream.

```sql
CREATE TABLE mail_messages (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  from_user_id uuid NOT NULL,
  subject text NOT NULL,
  body_html text, body_text text,
  importance text NOT NULL DEFAULT 'normal',
  in_reply_to_id uuid,
  external_message_id text,          -- RFC 5322 Message-ID when the bridge is on
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE mail_recipients (
  tenant_id uuid NOT NULL, message_id uuid NOT NULL,
  recipient_type text NOT NULL,      -- to | cc | bcc
  user_id uuid, external_address citext,     -- one or the other
  PRIMARY KEY (tenant_id, message_id, recipient_type, COALESCE(user_id::text, external_address))
);

-- One row per (message, user): this is what makes a mailbox a mailbox.
CREATE TABLE mail_envelopes (
  tenant_id uuid NOT NULL, id bigserial,
  user_id uuid NOT NULL, message_id uuid NOT NULL, thread_id uuid NOT NULL,
  folder_id uuid NOT NULL,
  is_read boolean NOT NULL DEFAULT false,
  is_flagged boolean NOT NULL DEFAULT false,
  is_draft boolean NOT NULL DEFAULT false,
  categories text[] NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, user_id, message_id)
);
CREATE INDEX ON mail_envelopes (tenant_id, user_id, folder_id, received_at DESC);

CREATE TABLE mail_folders (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  user_id uuid,                       -- null = system folder shared shape
  name text NOT NULL, kind text NOT NULL,   -- inbox|sent|drafts|archive|trash|custom
  parent_id uuid, display_order int,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE mail_rules (             -- Outlook-style rules
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, name text NOT NULL,
  conditions jsonb NOT NULL,          -- from, subject contains, has attachment
  actions jsonb NOT NULL,             -- move to folder, flag, categorise, mark read
  priority int NOT NULL DEFAULT 100, enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id)
);
```

Also required for genuine Outlook parity, each a real piece of work: delegate/shared mailboxes, out-of-office auto-reply (which should read from the leave module — a natural PEPL advantage), signatures, conversation view, quoted-reply rendering, and full-text search over subject + body + attachment text.

### 5.1 Decided: internal mail + outbound send only

**No inbound SMTP. No MX records. No IMAP/EWS.** PEPL users mail each other internally, and can additionally *send* to external addresses (a candidate, a vendor, an ex-employee's personal address). Replies from outside arrive in the recipient's normal email, not in PEPL.

This is the right cut: it delivers the useful half — HR sending offer letters, policy notices and payslip notifications from inside the system, to anyone — without PEPL becoming a mail provider competing with Microsoft 365 and Google Workspace.

`mail_recipients.external_address` and `mail_messages.external_message_id` already carry it; no migration is needed if full inbound is ever added.

### 5.2 Outbound bridge — what "send only" actually costs

Sending to the open internet is not a checkbox. It is a deliverability discipline, and getting it wrong means offer letters land in spam.

```
mail_messages (external recipients present)
        ↓
   outbound queue  (rate-limited per tenant)
        ↓
   suppression check  ← hard bounces, complaints, unsubscribes
        ↓
   SES / SendGrid  (DKIM-signed, SPF-aligned, DMARC-passing)
        ↓
   webhook: delivered | bounced | complained | opened
        ↓
   mail_delivery_events  → surfaced on the message in the sender's Sent folder
```

```sql
CREATE TABLE mail_outbound (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL, to_address citext NOT NULL,
  from_address citext NOT NULL,          -- tenant sending identity, see below
  provider_message_id text,
  status text NOT NULL DEFAULT 'queued', -- queued|sent|delivered|bounced
                                         -- |complained|suppressed|failed
  attempts int NOT NULL DEFAULT 0, last_error text,
  queued_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE mail_delivery_events (      -- append-only, provider webhooks
  tenant_id uuid NOT NULL, id bigserial,
  outbound_id uuid NOT NULL, event_type text NOT NULL,
  provider_event_id text NOT NULL, payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_event_id)  -- webhooks arrive twice
);

CREATE TABLE mail_suppressions (         -- global across tenants, by address
  address citext PRIMARY KEY,
  reason text NOT NULL,                  -- hard_bounce|complaint|manual
  suppressed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_sending_domains (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  domain text NOT NULL,
  dkim_tokens jsonb, spf_verified boolean NOT NULL DEFAULT false,
  dkim_verified boolean NOT NULL DEFAULT false, dmarc_observed text,
  status text NOT NULL DEFAULT 'pending',
  verified_at timestamptz,
  PRIMARY KEY (tenant_id, id), UNIQUE (domain)
);
```

Decisions this forces, all of which belong in the architecture now:

- **Sending identity.** Default is `hr@{tenant-slug}.mail.pepl.app` — our domain, our reputation, works on day one. A tenant that wants mail from `hr@theircompany.com` verifies their own domain (DKIM CNAMEs + SPF), and until verified we send from ours with their name as the display name. Never send *as* an unverified domain; that is what gets a sending platform blocked.
- **Reputation is shared and must be protected.** One tenant blasting 5,000 messages damages deliverability for every other tenant. Therefore: per-tenant send quotas from `tenant_entitlements.limits`, a global suppression list honoured across all tenants, complaint-rate monitoring per tenant, and automatic throttling of a tenant whose bounce or complaint rate crosses a threshold.
- **Suppression is global, not per tenant.** An address that hard-bounced or complained is never mailed again by anyone on the platform. This is the single most important deliverability control.
- **Bounces are visible to the sender.** A failed offer letter must show as failed in the sender's Sent folder, not vanish. Delivery state renders on the message.
- **Anti-abuse.** A public-signup product that can send mail to arbitrary addresses is a spam vector. Outbound is disabled during trial by default, enabled on payment, and rate-limited always (see `platform-control-plane.md` §8).

---

## 6. Announcements

Not chat, not mail. A publication with an audience and an acknowledgement requirement — the compliance shape HR actually needs ("did everyone read the new leave policy?").

```sql
CREATE TABLE announcements (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  title text NOT NULL, body_html text NOT NULL,
  author_user_id uuid NOT NULL,
  audience jsonb NOT NULL,           -- {"department_ids":[],"location_ids":[],"all":true}
  channels text[] NOT NULL DEFAULT '{in_app}',  -- in_app|email|push|whatsapp
  requires_acknowledgement boolean NOT NULL DEFAULT false,
  pinned_until timestamptz,
  publish_at timestamptz, expires_at timestamptz,
  status text NOT NULL DEFAULT 'draft',
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE announcement_receipts (
  tenant_id uuid NOT NULL, announcement_id uuid NOT NULL, user_id uuid NOT NULL,
  delivered_at timestamptz, viewed_at timestamptz, acknowledged_at timestamptz,
  PRIMARY KEY (tenant_id, announcement_id, user_id)
);
```

Acknowledgement tracking is what makes this an HR feature rather than a noticeboard: policy acceptance with a name, a timestamp and a document version is evidence.

---

## 7. Shared substrate

| Concern | Approach |
|---|---|
| **Attachments** | One upload service for chat, mail, documents. Presign → client uploads directly to S3 → server records metadata → async virus scan + thumbnail/transcode. A message with a `pending` scan renders as "scanning". |
| **Limits** | Max file size, allowed MIME types and per-tenant storage quota come from `tenant_entitlements.limits` and tenant settings. |
| **Search** | Postgres FTS per tenant over messages, mail and announcements, with a trigram index for names. Attachment text extraction (PDF/DOCX) into a `searchable_text` column. OpenSearch only if this measurably fails. |
| **Identity** | No separate chat user store. Participants are PEPL users; the directory, org chart and avatars are already present. |
| **Lifecycle** | `employee.exited` removes the user from all conversations, disables their mailbox, and (per tenant setting) either transfers or archives their mail. Automatic — this is the core advantage over WhatsApp. |

---

## 8. Compliance, retention and the part that is easy to get wrong

Internal messaging inside an HRMS **becomes evidence in workplace disputes**. That is simultaneously the strongest reason for the feature and its heaviest obligation. It must be designed in, not discovered during a harassment investigation.

- **Retention** is per tenant and per surface (chat, mail, announcements), enforced by partition drop for chat and a purge job for mail. Defaults: chat 3 years, mail 8 years, announcements permanent.
- **Legal hold**: a flag on a conversation, a user or a date range that **suspends retention purges**. Without this, a routine purge destroys evidence in an active investigation — a serious problem, and cheap to prevent now, expensive to add later once purging is live.
- **Admin visibility is a configured policy, not a hidden capability.** A tenant chooses between: no admin access to DMs; access on a documented request with reason; or full access. Whatever they choose, **employees are shown the policy**, and every admin read of a conversation writes an `audit_event`. Silent employer surveillance of employee messages is both an ethical failure and, under DPDP's notice requirements, a legal exposure. PEPL should never ship a silent-read capability.
- **Export**: per user, per conversation, per date range — for DPDP access requests, investigations and offboarding.
- **Deletion semantics**: "delete for me" hides the envelope; "delete for everyone" tombstones the message but retains it for the retention window under legal hold. The UI must not promise erasure the system does not perform.
- **DPDP**: messages are personal data. Notice at first use, purpose limitation (this is a work tool), retention limits, and the access/erasure paths above.

---

## 9. Build vs. buy

At PEPL's scale, hosted chat SDKs (Stream, Sendbird and similar) start around **$400/month and rise to $800–3,000/month** at enterprise tiers — cheap against the engineering cost of building. The disqualifier is not price.

**The disqualifier is data custody.** Employee conversation history living in a vendor's multi-tenant database is a poor fit for a product whose entire premise is that the company owns its employee data, and it complicates DPDP obligations (a sub-processor to disclose, notify and contract for), legal hold, and per-tenant export.

| Option | Verdict |
|---|---|
| Hosted SDK (Stream/Sendbird) | **Best for a fast, credible v1.** Accept the sub-processor disclosure; use it to validate that customers actually use in-HRMS chat before committing engineers. |
| Self-hosted Matrix/Element | Full data custody, but federation and ACL complexity make it heavy to operate for a business chat use case. Not recommended. |
| Build on Postgres + Redis (this document) | Full custody, full `hrms_ref` integration, no per-MAU meter. **The right end state**, and the schema above is the plan for it. |

**Recommended path:** design to the model in this document from the start, and decide between buying the transport for v1 versus building it based on whether the org-integrated features (`hrms_ref`, auto-membership, lifecycle removal, legal hold) can be achieved through the vendor's API. If they cannot — and they largely cannot — building is the honest answer, and it should be scheduled as its own project with its own team, not slotted into an HRMS sprint.

---

## 10. Build sequence

```
Wave 4   Notifications   in-app centre + push + email/WhatsApp dispatch
Wave 4   Announcements   publication · audience · acknowledgement tracking
Wave 6   Tasks           comments = the first threaded-discussion primitive
Wave 7   Mail            per-user IMAP/SMTP client  (mail.md)
Wave 7   Chat            DMs → groups → media → receipts → presence
```

**Announcements land before chat** because they need no real-time infrastructure and produce the acknowledgement tracking that carries compliance value. Chat is the largest single subsystem in the platform and depends on nothing else, so it sits late in the sequence where it can absorb schedule risk without blocking payroll.

---

## 11. Open decision

**Does the mailbox send and receive real external email, or is it internal-only?**

Everything in §5 is written to support internal-only now with an external bridge later. If real external email is required at launch, that is a separate multi-month workstream with permanent operational burden (deliverability, spam, DMARC, bounce handling) and should be scoped as its own project — not as a feature of the HRMS.
