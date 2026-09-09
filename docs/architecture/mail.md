# PEPL — Mail architecture

**Model: PEPL is a mail *client*, not a mail *provider*.** Each user connects their existing company mailbox over IMAP/SMTP (or OAuth); PEPL renders it in an Outlook-style surface inside the HRMS.

This matches how companies already work: a firm has mail — Google Workspace, Microsoft 365, Zoho, or IMAP on their own hosting — before they buy an HRMS, and they are not going to migrate it. PEPL surfaces that mailbox next to the employee record rather than asking anyone to change providers.

This supersedes `communication.md` §5.2. There is no outbound sending domain, no MX record, no DKIM reputation to defend, no suppression list, and no possibility of PEPL being used as a spam relay. Mail sent from PEPL is genuinely *from the user*, through their own provider, and lands in their own Sent folder.

---

## 1. Non-negotiable client-side requirements

Every serious IMAP client implementation needs these. They are listed first because each one, omitted, produces a specific and well-known failure.

| Decision | Why it exists |
|---|---|
| **IMAP/SMTP proxied server-side** | Browsers cannot speak IMAP. All mail I/O is a JSON API. |
| **Credentials encrypted at rest** (AES-256-GCM) | Decrypted per use inside the worker only; never logged, never in an error message, never returned by any endpoint. |
| **SSRF guard on every connect** (`assertPublicHost`) | A user-supplied hostname is an SSRF primitive. Private ranges, loopback and link-local are refused *before* a socket opens. Non-negotiable, and doubly so on public signup. |
| **An `error` listener on every IMAP client object** | A socket timeout surfaces as an EventEmitter `error`, not a rejected promise. Unhandled in Node, it becomes an uncaught exception that kills the process. Mail is auxiliary and must never be able to stop attendance or payroll. |
| **Autodetect from the email domain** (`mail.{domain}`, 993 implicit TLS / 587 STARTTLS) | Matches cPanel/CyberPanel/Postfix defaults, which is what most Indian SMEs run. Saves the user from a settings form they cannot fill in. |
| **`requireTLS` on port 587** | Fail rather than send credentials in plaintext when STARTTLS is absent. |
| **Special-use folder mapping with name fallbacks** | `\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive`, then regex on names. Servers vary; this handles both. |
| **UID baseline on first sync** | Never announce a mailbox's existing backlog as "new mail". |
| **Announcement cap per cycle** | Stops a notification flood after an outage. |

---

## 2. Scale requirements

A naive implementation — connect per request, poll every account on a fixed timer, store a password — works for a handful of users on one mail server and fails predictably across thousands of accounts on providers we do not control.

| # | Naive approach | Fails because | PEPL |
|---|---|---|---|
| 1 | Connect + `logout` per request | Every folder open is a fresh TLS handshake + LOGIN. At scale this is seconds of latency and a connection storm against customers' servers, which will rate-limit or ban us | Pooled, long-lived connections per account with IDLE |
| 2 | Poll every account every 60 s | 10,000 accounts × 1 poll/min = 167 connects/second, all at the same instant | Sharded, jittered scheduler + IDLE where supported + backoff |
| 3 | Password auth only | Google Workspace and Microsoft 365 — what most public customers use — require OAuth2/XOAUTH2; app passwords are being withdrawn | OAuth2 first-class, password as fallback |
| 4 | Key derived from `JWT_SECRET` if `MAIL_ENC_KEY` unset | Rotating the app signing secret would silently brick every stored mailbox password | Per-tenant DEK, envelope-encrypted under a KMS master key, versioned |
| 5 | Auto-provision by trying the login password against the mail server | Only valid where the HRMS and mail share one identity directory. Against a third party it means testing a user's password on a server we do not control | Explicit connect only; auto-provision is opt-in per tenant, for firms whose mail and HRMS genuinely share credentials |
| 6 | No local cache — every list hits IMAP | Unusable latency, no cross-folder search, no offline mobile | Local envelope cache + sync state; bodies fetched on demand |
| 7 | Mail accounts keyed by user alone | No tenant column means no RLS, so no isolation guarantee on the most sensitive table in the system | `tenant_id` on every row, RLS with `FORCE` |
| 8 | No admin surface | A company cannot enforce its own mail policy — which providers, whether OAuth is mandatory, whether attachments may be filed | Fully configurable per `configurability.md` |

---

## 3. Architecture

```
   Web (Outlook-style)          Mobile (Flutter)
            └───────────┬───────────┘
                        │ REST + SSE
                        ▼
              ┌──────────────────────┐
              │   Mail API (module)  │  never opens an IMAP socket itself
              └──────────┬───────────┘
                         │ reads/writes
          ┌──────────────┴───────────────┐
          ▼                              ▼
  ┌───────────────┐            ┌──────────────────────┐
  │ Envelope cache│            │  Command queue       │
  │  (Postgres)   │            │  (send, flag, move)  │
  └───────▲───────┘            └──────────┬───────────┘
          │ writes                        │ consumed by
          │                               ▼
       ┌──┴───────────────────────────────────────────┐
       │          MAIL WORKER POOL (isolated)         │
       │  ┌────────────┐  ┌───────────┐  ┌─────────┐  │
       │  │ Sync worker│  │IDLE worker│  │SMTP send│  │
       │  └────────────┘  └───────────┘  └─────────┘  │
       │  connection pool · circuit breakers · backoff│
       └───────┬──────────────────────────────────────┘
               │ IMAP / SMTP / OAuth2
               ▼
   Customer mail servers (Gmail · M365 · cPanel · Postfix · Zoho)
```

**The API process never opens a mail socket.** Mail I/O lives in a separate worker pool behind a process boundary, so a hung IMAP handshake degrades mail and nothing else. A customer's slow or dead mail server must never be able to affect attendance or payroll — the modules the company actually depends on.

---

## 4. Schema

```sql
CREATE TABLE mail_accounts (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  email citext NOT NULL, display_name text,
  provider text NOT NULL,              -- gmail|m365|zoho|imap_generic
  auth_type text NOT NULL,             -- oauth2 | password
  -- password auth
  imap_host text, imap_port int, imap_secure boolean,
  smtp_host text, smtp_port int, smtp_secure boolean,
  username text,
  secret_ciphertext bytea,             -- AES-256-GCM under the tenant DEK
  secret_key_version int,              -- supports rotation without re-prompting
  -- oauth
  oauth_access_ciphertext bytea, oauth_refresh_ciphertext bytea,
  oauth_expires_at timestamptz, oauth_scopes text[],
  -- sync state
  status text NOT NULL DEFAULT 'connected',  -- connected|auth_failed|unreachable
                                             -- |quarantined|disconnected
  last_error text, consecutive_failures int NOT NULL DEFAULT 0,
  quarantined_until timestamptz,
  capabilities jsonb,                  -- IDLE, CONDSTORE, QRESYNC, MOVE, X-GM-EXT-1
  is_shared boolean NOT NULL DEFAULT false,
  signature_html text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, user_id, email)
);

CREATE TABLE mail_folders (
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  path text NOT NULL,                  -- IMAP path, server-native
  name text NOT NULL, role text,       -- inbox|sent|drafts|trash|junk|archive|custom
  uid_validity bigint, uid_next bigint,
  highest_modseq bigint,               -- CONDSTORE/QRESYNC incremental sync
  last_synced_at timestamptz,
  unread_count int NOT NULL DEFAULT 0, total_count int NOT NULL DEFAULT 0,
  subscribed boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, account_id, path)
);

-- Envelopes only. Bodies are NOT stored by default (see §8).
CREATE TABLE mail_envelopes (
  tenant_id uuid NOT NULL, id bigserial,
  account_id uuid NOT NULL, folder_id uuid NOT NULL,
  uid bigint NOT NULL, message_id text, thread_key text,
  from_name text, from_address citext,
  to_addresses jsonb, cc_addresses jsonb,
  subject text, preview text,          -- first ~200 chars, for the list view
  sent_at timestamptz, received_at timestamptz,
  size_bytes int,
  is_seen boolean NOT NULL DEFAULT false,
  is_flagged boolean NOT NULL DEFAULT false,
  is_answered boolean NOT NULL DEFAULT false,
  is_draft boolean NOT NULL DEFAULT false,
  has_attachment boolean NOT NULL DEFAULT false,
  attachment_meta jsonb,               -- [{name,type,size}] — names only, not content
  search_tsv tsvector,
  cached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, account_id, folder_id, uid)
);
CREATE INDEX ON mail_envelopes (tenant_id, account_id, folder_id, received_at DESC);
CREATE INDEX ON mail_envelopes USING gin (search_tsv);

-- Every mutating action is queued, not executed inline.
CREATE TABLE mail_commands (
  tenant_id uuid NOT NULL, id bigserial,
  account_id uuid NOT NULL, user_id uuid NOT NULL,
  command text NOT NULL,               -- send|reply|flag|unflag|seen|unseen
                                       -- |move|delete|save_draft|append
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued',  -- queued|running|done|failed|abandoned
  attempts int NOT NULL DEFAULT 0, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, account_id, idempotency_key)
);

CREATE TABLE mail_delegations (        -- shared / delegate mailboxes
  tenant_id uuid NOT NULL, id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  grantee_user_id uuid NOT NULL,
  access text NOT NULL,                -- read | send_as | send_on_behalf | full
  granted_by_user_id uuid NOT NULL, expires_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
```

All tables carry `tenant_id` and run under RLS with `FORCE ROW LEVEL SECURITY`, per `tenancy-security.md` §1. A mail envelope is among the most sensitive rows in the platform; it gets the same isolation as payroll and the same three independent checks.

---

## 5. Sync engine

### Connection strategy

- One pooled IMAP connection per **active** account, held open, reused. "Active" = the user has the mail surface open, or the account has IDLE support and is within its watch window.
- **IDLE** where the server advertises it: near-instant new-mail delivery, no polling. Re-issued every ~9 minutes (before the 29-minute RFC limit).
- **Polling fallback** where IDLE is absent, on a jittered schedule derived from `hash(account_id)` so 10,000 accounts spread across the interval instead of firing together.
- **Adaptive interval**: 1 min for accounts used today, 15 min for accounts idle a week, 1 hour beyond a month. Most mailboxes in an HRMS are checked rarely; polling them all at 60 s is wasted capacity.

### Incremental sync

1. Compare `UIDVALIDITY` — if it changed, the server renumbered everything: drop the cache for that folder and resync.
2. With **CONDSTORE/QRESYNC**: fetch changes since `HIGHESTMODSEQ`. One round trip for flag changes and new mail.
3. Without: fetch `uid > uid_next_last_seen` for new mail, plus a bounded flag resync over the most recent N messages.
4. Envelopes upserted into `mail_envelopes`; `search_tsv` built from subject + participants + preview.

### Bodies

Fetched **on demand** when a message is opened, streamed through the API, and **not persisted by default** (see §8). A short-lived Redis cache (minutes) covers the common read-then-reply pattern. Attachments stream through with content-type sniffing and a size cap; they are never written to our object store unless the user explicitly saves one to Documents — which is an ordinary `documents` row with an audit event.

### Failure handling

- **Circuit breaker per account.** Consecutive failures → exponential backoff → `quarantined` with `quarantined_until`. A dead mail server never consumes worker capacity in a retry loop.
- **`auth_failed` is terminal**, not retried: retrying a wrong password locks the user out at the provider. Status flips to `auth_failed`, the user is notified in-app, and sync stops until they reconnect.
- **Every client gets an `error` listener**, enforced by a lint rule. An unhandled IMAP socket error is an uncaught exception, and an uncaught exception in a shared process is an outage.
- Mail worker health is a separate dashboard from API health, and mail being down never fails a readiness probe for the main API.

---

## 6. Sending

```
compose → POST /mail/send  → mail_commands (queued, idempotency_key)
                           → 202 Accepted, optimistic row in the UI
                           ↓
                    SMTP worker
                      ├─ build MIME (MailComposer)
                      ├─ send via the user's SMTP / Graph / Gmail API
                      ├─ APPEND to the Sent folder if the provider does not
                      └─ update command status → SSE → UI confirms
```

- **Queued, not inline.** A slow SMTP server must not hold an HTTP request open, and a retried request must not send twice — hence `idempotency_key`.
- **Sent-folder handling differs by provider**: Gmail and M365 file the sent copy automatically; generic IMAP servers do not, so the worker appends it. Double-filing is a common bug in mail clients; the capability is detected per account and recorded.
- **Failure is visible.** A failed send returns to the composer as a draft with the error, never silently vanishing.
- **Templates**: HR letters, offer letters and payslip notifications compose from the tenant's letter templates with employee variables resolved — the feature that justifies mail living inside the HRMS rather than beside it.
- **Out-of-office** is generated from the leave module: an approved leave can set the auto-reply on the user's own server (where supported) and clear it on return. This is a genuine advantage no standalone mail client has.

---

## 7. Credential custody

The single highest-risk data PEPL holds after bank details.

```
KMS master key (per environment, rotatable, never leaves the KMS)
        │  encrypts
        ▼
tenant DEK  (one per tenant, cached in memory with a short TTL)
        │  AES-256-GCM
        ▼
mail_accounts.secret_ciphertext / oauth_refresh_ciphertext
```

- **Per-tenant DEK**, not one global key. A compromise is bounded to one tenant, and per-tenant crypto-erase becomes possible: destroy the DEK and that tenant's stored credentials are unrecoverable.
- **`secret_key_version`** on every row so keys rotate without re-prompting thousands of users.
- **No derivation from `JWT_SECRET`.** The internal fallback is convenient at one deployment and unacceptable here: rotating the app signing secret would brick every mailbox.
- Decryption happens **only in the mail worker**, never in the API process, and never in a log, an error message, an audit `before`/`after`, or any API response.
- **OAuth is strongly preferred** and is the only option offered for Gmail and M365. Refresh tokens are revocable by the user at the provider — a materially better security posture than storing a password, and increasingly the only thing those providers accept.

---

## 8. Privacy, retention and the processor boundary

The customer's mailbox belongs to the customer. PEPL is a processor with a narrow, stated purpose: displaying and sending their mail inside the HRMS.

- **Bodies are not stored by default.** Envelopes are cached because a mail client is unusable otherwise; bodies are streamed. A tenant may opt into body caching for offline mobile and cross-folder full-text search — an explicit setting, off by default, with its own notice.
- **Retention on the cache** is short (default 180 days of envelopes) and configurable. Purging the cache never touches the user's actual mailbox.
- **Disconnecting an account** deletes every cached envelope, folder and credential for it immediately. This must be one click and must actually complete.
- **Employee exit** disconnects the mailbox automatically on `employee.exited` — the lifecycle advantage of mail living in the HRMS.
- **No admin reading of employee mailboxes.** A tenant admin can govern *whether* mail is enabled and *which providers* are permitted; they cannot read another user's mail through PEPL. Delegation exists (`mail_delegations`) but requires an explicit grant, is visible to the mailbox owner, and is audited on every access. Silent employer access to an employee's mail is not a feature PEPL will ship.
- **DPDP**: mail credentials and cached envelopes are risk tier 3 (`tenancy-security.md` §4). Notice at connect, purpose limitation, access export, and deletion on disconnect.

---

## 9. Tenant configuration

Per `configurability.md`, the tenant admin controls all of it for their company alone:

| Setting | Default | Notes |
|---|---|---|
| `mail.enabled` | on | Module toggle; disabling hides the surface and stops all sync |
| `mail.allowed_providers` | all | Restrict to e.g. M365 only |
| `mail.require_oauth` | off | Forbid password auth entirely |
| `mail.allowed_domains` | any | Only `@company.com` mailboxes may be connected |
| `mail.autoprovision_from_login` | **off** | Only meaningful where the company's mail and HRMS share one credential directory |
| `mail.cache_bodies` | off | Enables offline + full-text body search; carries a notice obligation |
| `mail.envelope_retention_days` | 180 | Cache retention only |
| `mail.max_attachment_mb` | 25 | |
| `mail.allow_external_send` | on | Restrict to internal recipients if required |
| `mail.allow_delegation` | on | Shared/delegate mailboxes |
| `mail.signature_template` | — | Tenant-wide default signature with employee variables |
| `mail.save_attachment_to_documents` | on | Whether users may file attachments into the employee document store |

`mail.autoprovision_from_login` defaults **off**. It is correct only for a company whose mail and HRMS share one credential directory, and wrong for everyone else.

---

## 10. API

```
POST   /mail/accounts                 connect (oauth start | imap credentials)
GET    /mail/accounts/:id/verify      test connection, report capabilities
DELETE /mail/accounts/:id             disconnect + purge cache + destroy credentials
GET    /mail/folders
GET    /mail/messages?folder=&cursor=&q=      from the envelope cache — fast
GET    /mail/messages/:uid            body on demand, streamed
GET    /mail/messages/:uid/attachments/:idx   streamed, size-capped, scanned
POST   /mail/send                     → queued, 202 + command id
POST   /mail/messages/:uid/flags      → queued
POST   /mail/messages/:uid/move       → queued
POST   /mail/drafts                   → queued
GET    /mail/sync/status              per-account state, last sync, errors
SSE    /mail/stream                   new mail, command results, sync state
```

The read path serves the cache and is fast; the write path is queued and eventually consistent, with the UI showing optimistic state and reconciling over SSE. That split is what makes a mail client usable over a network we do not control.

---

## 11. Build notes

- `imapflow` (IMAP), `nodemailer` + `MailComposer` (SMTP/MIME), `mailparser` (parsing) are the mature Node choices.
- The SSRF guard on user-supplied hostnames is mandatory and must run before any socket opens, on every path including background sync.
- Enforce the `error`-listener rule with a lint check rather than review discipline.
- Add Gmail API and Microsoft Graph as provider adapters behind the same interface as generic IMAP: better throughput, real push, and none of the IMAP quirks — for the two providers most companies actually use.
- The mail worker pool is the natural first component to deploy separately from the API.
