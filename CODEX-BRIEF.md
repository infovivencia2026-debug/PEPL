# PEPL — full brief for the UI build

This supersedes `API-HANDOFF.md` and contains it. Part 1 is the original handoff,
corrected where the backend has moved on. Part 2 is everything built since. Part 3
is what to build next and what is still genuinely missing.

The backend is complete and tested for every feature described here: **587 tests,
120 routes, 20 launch checks, all green in one run.**

---

# Part 0 — Run it

```bash
npm install
npm run db:setup      # roles + database + extensions (needs a local Postgres)
npm run migrate       # 25 migrations
npm run seed:demo     # a realistic 10-person company
npm run api           # http://localhost:4010
npm run openapi       # regenerates openapi.json from the live route table
```

`openapi.json` is **generated from the router**, so it cannot drift from what the
server serves. Regenerate it rather than editing it.

## Demo logins

Password for every account: `demo-password-2026`

| Email | Role | What they can see |
|---|---|---|
| `admin@acme.test` | org_admin | Everything, including settings and roles |
| `priya@acme.test` | hr_admin | People, attendance, leave, tickets — **not salary** |
| `anil@acme.test` | payroll_admin | Payroll, compensation, bank export |
| `finance@acme.test` | finance | Payroll read, bank export, approvals |
| `arjun@acme.test` | manager | His own reports only — no compensation |
| `rahul@acme.test` | employee | His own record only |
| `auditor@acme.test` | auditor | Read-only across the company, including the activity log |

Build against all seven. The permission model is real: a screen that looks right as
`admin` will be empty or 403 as `employee`, and that is correct behaviour, not a bug.

---

# Standing UI instructions

**The reference screenshot (PeopleNest HR) is the source of truth for the
visual design.** Match it — layout, proportions, the stat tiles, the donuts, the
payroll bars, the orange culture card, the announcements photo. Do not
substitute your own judgement for it.

There is exactly **one deliberate deviation**, below. Everything else in the
reference stands.

## The one deviation: no "View all" arrows

The reference shows a small `View All →` link in the corner of every card.
**Do not implement it.** This is the product owner's decision and it overrides
the reference.

The whole card is already the link — the anchor sits on the title with a
stretched `::after` overlay (`web/src/ui.tsx`, `Card`). A second, smaller target
for the same destination is redundant, and as CSS generated content it is
announced by screen readers as part of the heading: *"Employee overview View
all →"*.

It has now been removed twice. The second time it was reintroduced here, which
is why the component-level removal did not hold:

```css
/* web/src/styles/reference.css — removed, do not restore */
.widget-content .card-head::after { content: 'View all  →'; }
.widget-content .card-linked .card-head::after { content: 'View all  →'; }
```

If a card needs a stronger affordance, style the existing whole-tile link.

## Accessibility gates — these are not style opinions

`npm run check:responsive` covers eight devices and is currently green: no
horizontal overflow, no target under 44px on touch, no text below the floor.
Keep it green. Four specific things found in the last review, still open:

1. **Contrast ≥ 4.5:1 for normal text.** The culture card is white on `#ed694e`
   — measured **3.12:1**. Keep the card and its colour; darken the gradient, or
   raise the text weight/size to large-text territory (≥18.66px bold).
2. **`aria-live="polite"`** on the dashboard pager status. Paging swaps every
   tile with no announcement (`web/src/WidgetBoard.tsx:127-130`).
3. **A disabled control must not eat focus.** Prev/Next go `disabled` while
   focused at the ends, dropping focus to `<body>` (`WidgetBoard.tsx:129`).
4. **`tabIndex={0}` needs a role and a reason.** `.widget-frame` and
   `.route-content` are both focusable and both measured non-scrollable on the
   dashboard — two focus stops that do nothing.

## Chat and mail are modules

Gated by `modules.chat` / `modules.mail` from `GET /api/v1/me`, never by role.
See §2.1 and §2.2.

---

# Part 1 — The rules that shape every screen

## 1. Call `GET /api/v1/me` first, and render from it

```json
{
  "userId": "…", "employeeId": "…",
  "roles": ["hr_admin"],
  "permissions": ["employee.read", "leave.approve", "…"],
  "scope": "all",
  "modules": { "leave": true, "attendance": true, "payroll": true,
               "helpdesk": false, "chat": false, "mail": false, "documents": true },
  "limits": { "employees": 1000 },
  "configVersion": "7"
}
```

**Drive navigation from `permissions` and `modules`, never from `roles`.** A tenant
can define custom roles with any name, so a role-name switch will be wrong for real
customers.

A disabled module returns `403 MODULE_NOT_AVAILABLE`. **Hide it** rather than showing
a disabled teaser — the company has decided it does not use that module.

> **Changed since the last brief:** `chat`, `mail` and `documents` are now modules in
> their own right. `chat` and `mail` default to **off**; `documents` defaults to
> **on**. This is why the chat and mail sections were missing from every account,
> including `rahul@acme.net` — they were never a permission problem, they simply did
> not exist. They exist now, and the nav must key off `modules.chat` / `modules.mail`.

## 2. Errors carry a stable code — switch on that

```json
{ "error": { "code": "CONFIG_EFFECTIVE_DATE_REQUIRED",
             "message": "…must carry an effective date, so a locked run stays reproducible",
             "details": { "missing": ["employeeNumber"] },
             "requestId": "…" } }
```

`message` is written to be shown to a user as-is. `requestId` correlates with the
server log — surface it in an error toast so support can trace it.

| Code | Status | What the UI should do |
|---|---|---|
| `VALIDATION_FAILED` | 422 | Highlight the fields in `details.missing` |
| `PERMISSION_DENIED` | 403 | Should not happen if you rendered from `permissions` — treat as a bug |
| `MODULE_NOT_AVAILABLE` | 403 | Hide the feature. `details.key` names the exact setting |
| `NOT_FOUND` | 404 | Also returned for a record outside the caller's scope. Do not say "forbidden" |
| `PERIOD_CLOSED` / `CONFIG_LOCKED_PERIOD` | 409 | Explain the period is closed and offer the next one |
| `SEPARATION_OF_DUTY` | 409 | "The person who ran this payroll cannot approve it" |
| `INSUFFICIENT_BALANCE` | 409 | Show the balance and the shortfall |
| `EMPLOYEE_LIMIT_REACHED` | 403 | Offer an upgrade; existing employees still work |
| `ACCOUNT_LOCKED` | 429 | Show the cooldown |
| `FILE_TOO_LARGE` | 413 | State the 10 MB limit before the upload, not after |
| `IMPORT_INVALID` | 422 | Render `details.errors` as a per-row table |
| `NOT_A_PARTICIPANT` | 403 | The conversation is not theirs — remove it from the list |
| `NOT_LOCKED` | 409 | A payslip PDF only exists once the run is locked |

## 3. Reasons are mandatory where money or history moves

Compensation changes, corrections, payroll revisions, balance adjustments, document
deletion and high-risk config changes all require `reason`. Make it a required field
with real placeholder text, not an optional note — the API rejects the request
without it, and the reason appears in the activity log forever.

## 4. Tenancy is invisible

There is no tenant id in any URL, header or body. The company is resolved from the
session. Do not build a tenant switcher.

## Money and dates

- **All money is an integer string of paise.** `"120000000"` is ₹12,00,000. Never
  parse it as a float; format with Indian grouping (`1,20,000`).
- **Dates are `YYYY-MM-DD` strings.** Timestamps are ISO-8601 UTC.
- **`day_fraction`** is `1`, `0.5` or `0`.

## Auth

```
POST /api/v1/auth/login  { email, password }  ->  { token, expiresAt, user }
Authorization: Bearer <token>   on every other request
POST /api/v1/auth/logout                      revokes immediately
```

Tokens are opaque and server-side; logout takes effect at once. On any `401`, drop
the token and return to login.

## Screens the API was already shaped for

**Employee list / profile.** `GET /employees` is already scoped — a manager gets
their reports, an employee gets themselves. Do not filter client-side.
`GET /employees/:id` omits `annual_ctc_paise` entirely for a caller without
`compensation.read`; render the section only when the field is present.

**The effective-dated change form** is the most important interaction in the product.
Every assignment or compensation change needs *what changed*, *effective from when*,
and *why*. Show a preview line — "Effective 1 Oct: Senior Developer → Lead Developer.
This does not affect September payroll."

**Corrections are a different action from changes.** "This was recorded incorrectly"
uses `/correct`, means something different, and deserves different copy and a
different button.

**Leave balances** return `opening`, `accrued`, `consumed`, `available` plus a ledger
endpoint that explains them. Make the balance a link to the ledger. "Why is my
balance 4.5?" should never become a support ticket.

**The inbox** (`GET /api/v1/inbox`) is one queue of approvals *and* tasks across every
module. Do not build separate screens per module — that is the failure that sends
managers back to WhatsApp. Support **send back** as prominently as approve/reject.

**Payroll** is a linear stepper: draft → frozen → calculated → validated → approved →
locked. Blockers in red, warnings in amber. After lock the button is **Revise**,
never Edit.

**Config** (`GET /api/v1/config`) returns every setting with label, help text, type,
default, current value and `changedFromDefault`. **Generate the settings screens from
this response** rather than hand-coding forms — there are now 33 settings and new
ones must appear automatically. Offer a "show only changed" filter. Settings with
`requiresEffectiveDate` need a date picker defaulting to the start of next month.

**Attendance** days carry a `status` plus independent attributes (`is_remote`,
`is_field_duty`, `day_fraction`). A day can be remote *and* half-day — render the
fraction and the remote mark separately, never as one letter.

---

# Part 2 — What is new

88 routes across 16 tags. Everything below is built, tested and reachable now.

## 2.1 Chat — 9 endpoints, `modules.chat`

A conversation is either a `dm` (exactly two people, forever) or a `group`.
**Membership is the permission** — there is no chat permission in the role model,
and no scope check. If you are in it, you can read it.

```
GET    /api/v1/chat/conversations
POST   /api/v1/chat/conversations                    { kind, title?, participantUserIds }
GET    /api/v1/chat/conversations/:id/messages       ?beforeId=&limit=
POST   /api/v1/chat/conversations/:id/messages       { clientMessageId, body, documentIds? }
PATCH  /api/v1/chat/conversations/:id/messages/:messageId   { body }
DELETE /api/v1/chat/conversations/:id/messages/:messageId
POST   /api/v1/chat/conversations/:id/read           { upToMessageId }
POST   /api/v1/chat/conversations/:id/participants   { userIds }
POST   /api/v1/chat/conversations/:id/leave
```

The conversation list is one query and arrives ready to render:

```json
{ "conversations": [{
    "id": "…", "kind": "group", "title": "Payroll cutoff",
    "unread": 3, "last_message_at": "…", "last_message_body": "Inputs freeze Friday.",
    "participant_ids": ["…", "…"], "is_readonly": false }] }
```

Build notes that matter:

- **`clientMessageId` is required and is the idempotency key.** Generate a UUID when
  the user hits send, keep it across retries, and an offline retry cannot double-post.
  The response is `{ id, created }` — `created: false` means it was already there.
- **Page with `beforeId`, never an offset.** Ids are monotonic per conversation, so a
  message arriving mid-scroll cannot shift the page and duplicate a row.
- **Unread excludes your own messages** and is per-person; move the watermark with
  `/read` when messages are actually on screen, not when the conversation opens.
- **A deleted message keeps its row** with `body: null` and `deleted_at` set. Render
  "This message was deleted" in place — do not drop it, or everyone's scroll jumps.
- **An edited message carries `edited_at`.** Show the marker; a silent edit in a
  workplace chat is a liability.
- Editing and deleting are **your own messages only** — a 404 otherwise.
- `chat.allow_groups` and `chat.allow_attachments` are separate tenant settings; both
  return `MODULE_NOT_AVAILABLE` with `details.key` naming which one.

## 2.2 Mail — 9 endpoints, `modules.mail`

An Outlook-shaped mailbox. Each person's mailbox is **created on first visit**, with
Inbox, Drafts, Sent, Archive and Trash already there — the UI never has to handle a
mailbox with no Inbox.

```
GET    /api/v1/mail/folders                  -> { account, folders: [{ id, name, role, total, unread }] }
GET    /api/v1/mail/messages                 ?folderId=&before=&q=&limit=   (defaults to Inbox)
GET    /api/v1/mail/messages/:id             -> { envelope, body_html, body_text }  (marks read)
GET    /api/v1/mail/threads/:threadKey       -> the whole conversation, oldest first
POST   /api/v1/mail/messages                 { to, cc?, bcc?, subject, bodyHtml, idempotencyKey, inReplyTo?, threadKey?, draftId? }
POST   /api/v1/mail/drafts                   { subject, bodyHtml, to?, cc?, draftId? }
POST   /api/v1/mail/messages/:id/flag        { flag: seen|unseen|flagged|unflagged }
POST   /api/v1/mail/messages/:id/move        { folderId }
DELETE /api/v1/mail/messages/:id             -> { purged: false }  (Trash first, purge second)
```

Build notes:

- **Send returns `{ sentEnvelopeId, deliveredTo, queuedFor }`.** Colleagues with a
  mailbox here are delivered instantly, in the same transaction; anyone else is
  queued for the SMTP worker. **Show that distinction** — "Sent to 2 colleagues,
  1 queued for delivery" is honest; a green tick for all three is not.
- **`idempotencyKey` is required.** Re-sending with the same key returns the original
  message rather than sending twice.
- **Opening marks read**, deliberately, so a list that scrolls past 40 messages does
  not mark 40 messages read.
- **Reply** = pass `threadKey` (and `inReplyTo` to mark the original answered).
- **Delete is two-stage**, like every mail client: `purged: false` means it went to
  Trash, `purged: true` means it is gone. The undo people reach for is Trash.
- The list endpoint takes `q` — subject, sender and preview, server-side.

## 2.3 Documents — 5 endpoints, `modules.documents`

One storage path for offer letters, ID proofs, policies, chat attachments and mail
attachments.

```
GET    /api/v1/documents?ownerType=&ownerId=    ownerType: employee|ticket|conversation|tenant
POST   /api/v1/documents      { ownerType, ownerId?, fileName, contentType, contentBase64, category?, isConfidential? }
GET    /api/v1/documents/:id                    metadata only
GET    /api/v1/documents/:id/content            -> { …metadata, contentBase64 }
DELETE /api/v1/documents/:id  { reason }
```

- **Base64 in, base64 out**, 10 MB ceiling. Check size in the browser first and show
  the limit before the upload, not as a 413 after it.
- An `employee` document obeys the same scope rule as the profile it hangs off.
- **Deletion destroys the bytes and keeps a tombstone** with the reason — so a
  retention request genuinely removes content while the audit trail still shows a
  file existed and who removed it.
- **Downloading a document is logged**, because a personnel file read is something a
  subject can ask about later.

## 2.4 Payslip PDF

```
GET /api/v1/payslips/:id/pdf
  -> { fileName, contentType: "application/pdf", sizeBytes, contentBase64 }
```

A real single-page A4 PDF: company name, the employee's details, earnings and
deductions in two columns, net pay with the amount in words, and employer
contributions listed separately and labelled *not deducted from you*.

- Only from a **locked** run — `409 NOT_LOCKED` otherwise.
- Turn `contentBase64` into a Blob and `URL.createObjectURL` for download or preview.
- Reading one is a tier-3 reveal and is written to the activity log.

## 2.5 Bulk employee import — 3 endpoints, `import.run`

```
GET  /api/v1/imports/employees/template    -> { fileName, contentType, content }
POST /api/v1/imports/employees/validate    { csv | csvBase64 }   dry run, writes nothing
POST /api/v1/imports/employees             { csv | csvBase64 }   all rows or none
```

Columns: `employee_number`, `first_name`, `date_of_joining` are required;
`last_name`, `department`, `designation`, `email` are optional. Headers are matched
loosely — case, spaces and underscores are ignored.

The validate response is the entire screen:

```json
{ "totalRows": 120, "valid": [ … ], "duplicates": ["A-014"], "willCreate": 119,
  "errors": [{ "row": 7, "field": "date_of_joining",
               "message": "date of joining must be YYYY-MM-DD, for example 2026-02-01" }] }
```

Build it as **upload → review → commit**. Render `errors` as a table keyed by row
number so a customer can fix the spreadsheet in one pass; the API deliberately
reports every problem at once rather than one per attempt. `duplicates` are
existing employee numbers — they are skipped, never overwritten. **Disable the
commit button while `errors` is non-empty**: the commit endpoint refuses a file with
any error rather than importing the good half.

## 2.6 Pagination

`GET /api/v1/attendance` and `GET /api/v1/employees/:id/timeline` now take `limit`
and `offset` and return `hasMore`. A month of attendance across 300 people is 9,000
rows; render "showing 500 of …" rather than a silently truncated month.

## 2.7 Realtime — `GET /api/v1/events`

Server-sent events, not a socket: everything travels server to client,
EventSource reconnects itself, and it is ordinary HTTP so the session cookie
already authenticates it. **Do not build polling.**

```ts
import { on } from './live'

useEffect(() => on('chat.message', (e) => {
  // e.data = { conversationId, messageId, senderUserId }
  if (e.data.conversationId === openConversationId) refetchMessages()
  else bumpUnreadBadge(e.data.conversationId as string)
}), [openConversationId])
```

`web/src/live.ts` is written and typed: `on(type, handler)` returns an
unsubscribe function, and one connection is shared by the whole app. Opening an
EventSource per component would exhaust the six-connection-per-origin budget and
stall ordinary requests.

Event types published today:

| Event | `data` | Who receives it |
|---|---|---|
| `chat.message` | `conversationId`, `messageId`, `senderUserId` | conversation members |
| `chat.conversation` | `conversationId` | its participants |
| `mail.delivered` | `subject`, `from` | the recipients with a mailbox here |
| `mail.received` | `accountId`, `folderId`, `folder` (role), `added` | the mailbox owner — external mail synced from IMAP (IDLE push or poll). Refetch the folder list and, if that folder is open, its envelopes |
| `approval.decided` | `requestId`, `status`, `action` | whoever raised it |
| `announcement.published` | `announcementId` | the audience |

Two guarantees worth relying on:

- **An event is published only after the transaction commits.** If you receive
  `chat.message`, refetching will find it. There is no window where the event
  arrives before the row exists.
- **Reconnect replays what was missed.** The server keeps the last 200 events per
  company and answers `Last-Event-ID` from it, so a tunnel or a sleeping laptop
  does not silently drop messages. This is handled inside EventSource; you do not
  write retry logic.

An event carries an id and enough to update a badge — never the message body.
Refetch on receipt: it keeps permissions in one place, and the stream cannot
become a way to read something the API would refuse.

## 2.8 Outbound mail actually sends

`mail.outbox` is a job (`npm run job mail.outbox`) that drains the queued
commands over SMTP, using the mailbox settings that person connected. So
`queuedFor` in the send response now genuinely means *queued and it will go*,
not *queued and nothing is listening*.

What the UI should still show honestly: **delivered** for colleagues (immediate,
in the same transaction) and **queued** for outside addresses (a job away). The
worker retries a temporary failure with backoff and abandons a permanent
rejection immediately, so a message can end up `abandoned` — worth surfacing in
a Sent folder as "could not be delivered".

Requires `PEPL_MAIL_KEY` in the environment; without it the job does nothing and
says so.

## 2.9 Notification email

`notifications.email` is a job that emails notifications marked for it, through
the same outbox. Three settings drive it, and all three belong on the settings
screen:

| Key | Default | Note |
|---|---|---|
| `notifications.enabled` | on | the bell itself |
| `notifications.email_enabled` | off | needs a sender below |
| `notifications.sender_email` | *(empty)* | a mailbox already connected in PEPL |

The sender is deliberate: mail from a domain PEPL does not own fails SPF and
lands in spam. The help text says so — surface it rather than shortening it.
A notification the person already read in the app is never emailed.

## 2.10 Salary disbursement — 4 endpoints, `bank.export` / `bank.read`

This is how money actually leaves. PEPL never holds it: the endpoint produces a
file the company uploads to their own bank.

```
GET  /api/v1/payments/formats                    -> { formats: [...] }        bank.read
POST /api/v1/payroll/runs/:id/bank-file          { format, valueDate }        bank.export
GET  /api/v1/payments/batches                    -> { batches: [...] }        bank.read
GET  /api/v1/payments/batches/:id                -> the batch with its file   bank.export
```

The generate response is the whole screen:

```json
{ "batchId": "…", "checksum": "…", "lineCount": 42,
  "totalPaise": "1840000000", "content": "…csv…", "reused": false }
```

Build notes, and please respect both:

- **`reused: true` means this file already existed.** Show it as "already
  generated on <date>", not as a fresh success. The endpoint is idempotent by
  design — one batch per run per channel — so a double-click cannot become a
  double payment. The UI's job is to make that visible rather than hide it.
- **Only a locked run.** Anything else is `409 RUN_NOT_LOCKED`. Do not offer the
  button before lock.
- `content` is the CSV as text. Turn it into a Blob for download; do not render
  it into the page — it contains every employee's account number.
- `422 MISSING_BANK_DETAILS` names the employees with no account on file. That
  list is the fix-it screen: nobody is silently skipped.
- Four formats today: `hdfc_neft_csv`, `icici_csv`, `axis_csv`,
  `generic_neft_csv`. Read them from `/payments/formats` rather than hard-coding.

Incentives also gained a read endpoint, `GET /api/v1/incentives/periods`
(`incentive.read`), returning each period with how many calculations it holds
and the total.

## 2.11 Four permissions were REMOVED

A second gate now fails the build on any permission no route asserts. It found
seven. `bank.read` and `bank.export` were among them — which is how the missing
bank endpoints above were discovered. Four had no feature behind them at all and
are gone:

| Removed | Why |
|---|---|
| `employee.delete` | offboarding is a status change; nothing hard-deletes an employee |
| `attendance.write` | punching is self-service under `attendance.read`; edits are `attendance.correct` |
| `attendance.approve` | attendance has no separate approval step — corrections and period close cover it |
| `leave.policy.write` | there is no leave-policy admin API yet; policies are seeded |

If a roles screen enumerates permissions, it takes them from
`GET /api/v1/roles` (`allPermissions`), so this needs no change on your side —
but four checkboxes will disappear, and `leave.policy.write` disappearing is the
one worth knowing about, because leave policy administration is genuinely
missing rather than merely unnamed.

---

## 2.12 Four settings were REMOVED

A gate now fails the build on any setting no code reads. It found twelve. Nine
were wired to real behaviour; **four were deleted, and a generated settings
screen will simply stop showing them**:

| Removed | Why |
|---|---|
| `attendance.grace_minutes` | late marking needs shift start times, which PEPL does not model |
| `leave.sandwich_holidays` | needs server-side day counting; the client currently sends `totalDays` |
| `leave.encashment_enabled` | there is no payout feature behind it |
| `payroll.employer_pf_in_ctc` | there is no CTC composition step to apply it to |

They come back when the feature behind them does. Nothing to build here — the
settings screen is generated from `GET /api/v1/config`, so they disappear on
their own.

What the nine wired ones now actually do, in case a screen explains them:

| Setting | Effect |
|---|---|
| `attendance.week_pattern` | a weekly off is `status: "weekly_off"`, never absence |
| `attendance.half_day_mode` + `half_day_hours` | a short day auto-marks as half |
| `attendance.remote_enabled` | `403 REMOTE_NOT_ALLOWED` when marking someone remote |
| `attendance.remote_is_paid` | a remote day carries no pay when this is off |
| `attendance.correction_window_days` | `409 CORRECTION_WINDOW_CLOSED` past the window |
| `leave.min_unit` | `422 LEAVE_UNIT_NOT_ALLOWED` for a disallowed fraction |
| `documents.max_upload_mb` | the real upload ceiling; `details.limitBytes` on the 413 |
| `chat.history_retention_days` | old message bodies cleared, message rows kept |
| `helpdesk.default_response_sla_minutes` | used when a category names no SLA of its own |

Two of these give you new error codes to handle:

| Code | Status | What the UI should do |
|---|---|---|
| `CORRECTION_WINDOW_CLOSED` | 409 | Say how far back this company allows, from the message |
| `REMOTE_NOT_ALLOWED` | 403 | Hide the mark-remote action entirely |
| `LEAVE_UNIT_NOT_ALLOWED` | 422 | Constrain the form's step to `details.minUnit` |

---

## 2.13 Settings that now exist

Twelve keys were added, all generated into the settings screen automatically.
After the four removals above there are 33 in total — hand-coding them is no longer viable, so build that screen
from `GET /api/v1/config`.

| Key | Default | Note |
|---|---|---|
| `chat.enabled` | off | entitlement-gated |
| `chat.allow_groups` | on | |
| `chat.allow_attachments` | on | |
| `chat.history_retention_days` | 0 | 0 = keep forever; high risk |
| `mail.enabled` | off | entitlement-gated |
| `mail.store_bodies` | off | high risk — caching message bodies in PEPL |
| `mail.allow_external_recipients` | on | off = colleagues only |
| `documents.enabled` | on | |
| `documents.max_upload_mb` | 10 | |
| `notifications.enabled` | on | |
| `notifications.email_enabled` | off | |
| `notifications.sender_email` | *(empty)* | free text; a connected mailbox |

---

## 2.14 Review of `Communications.tsx` against the API contract

Read after the first chat/mail screens landed. The important things are right:
the cookie → bearer path works through the dev proxy, HTML is parsed to text
on the way in and escaped on the way out, and the idempotency key rotates only
after a successful send, so a failed send retries with the same key. No
security findings. Five logic gaps, in order of user impact:

**1. Unread counts never clear.** Nothing calls
`POST /chat/conversations/:id/read { upToMessageId }`, so the badge in the
sidebar stays forever once a message arrives. Call it when the thread's
messages are actually on screen — after `setMessages`, with the highest `id`
in the list — not when the conversation is merely selected.

**2. The sidebar does not refresh on a new message.** It subscribes to
`chat.conversation` (a new conversation) but not `chat.message`, so
`last_message_body` and `unread` for *other* conversations go stale until a
manual refresh. Subscribe to both; refresh the list on either.

**3. Sending a saved draft leaves the draft behind.** `POST /mail/drafts`
returns `{ id }`; keep it, and pass `draftId` on the eventual
`POST /mail/messages`. The server deletes the draft on send. Without it, every
draft that is later sent is also still in Drafts.

**4. There is no way to start a conversation.** The screen lists what exists.
`POST /chat/conversations { kind: 'dm' | 'group', participantUserIds, title? }`
is built; the demo tenant now has chat enabled, so it can be exercised. A
directory to pick colleagues from is `GET /api/v1/employees` (already scoped).

**5. Threads show only the latest page.** `GET …/messages` returns
`{ messages, hasMore }`; the UI ignores `hasMore`. Load older with
`?beforeId=<lowest id shown>` when the user scrolls to the top.

One more, about the verification script: `scripts/check-connect.mjs` intercepts
`**/api/v1/mail/**` and answers with fixtures, so "compose and draft flow
passed" there proves the UI, not the wiring. `npm run smoke` drives the real
backend as the seeded users (39 checks, chat and mail included) — run it as
well, with the app up, and run it against `SMOKE_BASE=http://127.0.0.1:5173`
to exercise the proxy path you develop on.

---

## 2.15 Leave administration — 7 endpoints, `leave.policy.write`

A company can now manage its own leave types and the rules behind them. This
belongs on the settings surface, next to the holiday calendar (§2.x holidays).

```
GET   /api/v1/leave/types?includeRetired=&asOf=     leave.read
POST  /api/v1/leave/types          { code, name, isPaid?, affectsLop?, reason }
PATCH /api/v1/leave/types/:id      { name?, isPaid?, affectsLop?, reason }
POST  /api/v1/leave/types/:id/retire      { reason }
POST  /api/v1/leave/types/:id/reinstate   { reason }
GET   /api/v1/leave/types/:id/policies    leave.read      -> every version, newest first
POST  /api/v1/leave/types/:id/policies    { accrualMethod, accrualUnitsPerPeriod, carryForwardLimit?,
                                            maxBalance?, encashable?, allowNegativeBalance?,
                                            minUnit?, probationAllowed?, effectiveFrom, reason }
```

The list returns each type with `policy` — the version **in force on `asOf`**
(today by default) — or `null` if none has started yet.

Rules a screen must reflect, because the server enforces them:

- **A policy is never edited.** There is no PATCH on a policy. A change is a new
  version with `effectiveFrom`; the current one is closed the day before. Show
  history, not an edit form.
- **`effectiveFrom` is today or later** — `422 POLICY_NOT_BACKDATABLE`. Default
  the date picker to the first of next month, like payroll-affecting settings.
- **A type is retired, not deleted.** Retired types vanish from the default
  list but keep every balance and request. Offer "Retire", never "Delete".
- **The code is immutable and upper-case** (1–12 chars, `[A-Z][A-Z0-9_]*`) —
  it appears on payslips. `422 INVALID_LEAVE_CODE`, `409 LEAVE_TYPE_EXISTS`.
- Every write takes a `reason` and lands in the activity log.

`accrualMethod` is one of `monthly | yearly | on_joining | none`; `minUnit`
is `full_day | half_day | hourly`. Amounts are plain numbers of days (1.5, not
paise).

## 2.16 Tax declarations — 6 endpoints, Chapter VI-A and HRA

Until now every payslip over-deducted TDS for anyone with a PPF, a health
policy or a rented flat, because no deductions existed. Now an employee
declares once per fiscal year, payroll verifies against proofs, and the
NEXT freeze deducts the allowed figure. Two screens:

**Employee — "My tax declaration"** (`payroll.read`, scope self):

| Verb | Path | Notes |
|---|---|---|
| GET | `/api/v1/tax-declarations/me?fy=2026-27` | `{ declaration, preview }`. `declaration` is null until the first save. `preview.lines[]` shows each section's `declaredPaise` vs `allowedPaise` with a `note` when the cap bit — render that side by side. |
| PATCH | `/api/v1/tax-declarations/me` | `{ fiscalYear, regime: 'old'\|'new', declared, proofDocumentIds? }`. ALWAYS returns the row to `draft`, even if it was verified — say so in the UI before an edit to a verified declaration. |
| POST | `/api/v1/tax-declarations/me/submit` | `{ fiscalYear }`. From `draft` or `rejected` only; 409 `DECLARATION_NOT_EDITABLE` otherwise. |

`declared` fields, all annual paise integers (anything else is silently
dropped): `section80cPaise`, `section80ccd1bPaise`, `section80dSelfPaise`,
`section80dParentsPaise`, `section80ePaise`, `section24bPaise`,
`section80gPaise`, `rentPaidAnnualPaise`; booleans `metro`, `parentsSenior`.

Regime matters: under `new` the preview is zero with a note explaining why —
show the note, do not hide the section list. `80G` is recorded for the
employee's return but never deducted through payroll; the note says so.

Proofs are document ids from §2.3 — the upload component you already have,
placed once more.

**Payroll — "Declarations queue"** (`payroll.process`):

| Verb | Path | Notes |
|---|---|---|
| GET | `/api/v1/tax-declarations?fy=2026-27&status=submitted` | `status` optional: `draft\|submitted\|verified\|rejected`. Default view is `submitted`. |
| POST | `/api/v1/tax-declarations/:id/verify` | `submitted` → `verified`. 409 `DECLARATION_NOT_SUBMITTED` otherwise. |
| POST | `/api/v1/tax-declarations/:id/reject` | `{ reason }`, required (422 `REASON_REQUIRED`). The employee sees `rejection_reason` on their screen. |

Status is a lifecycle, so show it as a stepper: draft → submitted → verified,
with rejected as a side exit that returns to editing. Colour alone is not
enough (§ accessibility gates above).

**What the UI must NOT imply:** verification changes the NEXT payroll freeze,
never a run already frozen or locked. If a declaration is verified after
September's freeze, September's payslip is unchanged and October's picks it
up. Put that sentence next to the verify button.

The payslip line `TDS` carries `calc_note.declaredDeductions` when a figure was
applied — the payslip screen can show "after ₹1,50,000 declared deductions".

## 2.17 Push notifications — 4 endpoints, no permission (own devices only)

Standard Web Push. The service worker and the subscribe flow are yours; the
server side is done.

| Verb | Path | Notes |
|---|---|---|
| GET | `/api/v1/push/vapid-public-key` | `{ publicKey }` for `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`. **503 `PUSH_NOT_CONFIGURED`** when the deployment has no keys or the company turned push off — hide the opt-in control in that case, do not show an error. |
| GET | `/api/v1/push/subscriptions` | My devices: `endpoint`, `user_agent`, `created_at`, `last_used_at`. For a "devices" list in settings. |
| POST | `/api/v1/push/subscriptions` | Body is exactly `subscription.toJSON()`: `{ endpoint, keys: { p256dh, auth } }`. Idempotent per endpoint. Call it after subscribing AND on `pushsubscriptionchange` in the worker. |
| DELETE | `/api/v1/push/subscriptions` | `{ endpoint }`. Call it on sign-out for the current device, after `subscription.unsubscribe()`. |

The payload the worker receives (`event.data.json()`) is
`{ id, type, title, body, entityType, entityId }` — the same fields as a
notification row, so tapping it can deep-link the same way the bell does.
Keep the worker's `showNotification` to title + body; do not fetch in the
worker.

Rules that are not optional:

- Ask for permission from a **user gesture** ("Turn on notifications" button),
  never on page load. A browser that has been asked on load says no forever.
- Only offer the control when `Notification` and `PushManager` exist AND the
  key endpoint returned 200.
- Push is a **second channel** for the same notification, not a different
  notification. If the tab is open and the bell already updated via SSE, the
  worker should still show it only when no window of ours is focused
  (`clients.matchAll` + `focused`).

## 2.18 Statutory identifiers and filings — 6 endpoints

Payroll computed PF, ESI, PT and TDS correctly from day one and produced no
return, so a company still did the month twice. Now a locked run yields the
files the portals take. Two screens.

**Identifiers, on the employee profile** (sensitive tier — beside bank details,
NOT on the tab every colleague sees):

| Verb | Path | Notes |
|---|---|---|
| GET | `/api/v1/employees/:id/statutory-ids` | `payroll.read`, scoped: an employee sees their own; payroll sees all. `null` until set. Fields: `uan`, `pf_member_id`, `esi_number`, `pan`. |
| PATCH | `/api/v1/employees/:id/statutory-ids` | `compensation.write`. Send only the fields being set; omitted ones are kept. 422 `VALIDATION_FAILED` with the shapes (UAN 12 digits, PAN `AAAAA9999A`, ESI 10 or 17 digits); 409 `DUPLICATE_IDENTIFIER` when a UAN/PAN is already on another employee — show the message, it names which. |

Show a missing UAN/PAN as a warning chip on the profile: a person without one
is silently left out of the return (the filing screen lists them, but the fix
is on the profile).

**Filings, on the payroll run page — locked runs only** (`payroll.process`):

| Verb | Path | What comes back |
|---|---|---|
| GET | `/api/v1/payroll/runs/:id/filings/ecr` | EPFO ECR `.txt` |
| GET | `/api/v1/payroll/runs/:id/filings/esi` | ESIC contribution `.csv` |
| GET | `/api/v1/payroll/runs/:id/filings/pt` | PT summary by slab `.csv` (a working paper — PT has no national format) |
| GET | `/api/v1/payroll/filings/24q?fy=2026-27&quarter=Q2` | Form 24Q Annexure I `.csv` across the quarter's locked runs |

Every one returns `{ fileName, contentType, rows, totalPaise, omitted[], contentBase64 }`
— the same download shape as the payslip PDF and the bank file. **`omitted` is
the important part of the response**: `[{ employeeNumber, name, reason }]` for
people left out because an identifier is missing. Render it above the download
button, not in a tooltip. A 409 `RUN_NOT_LOCKED_FOR_FILING` means the run can
still change; disable the buttons until the run is locked rather than showing
the error.

Company registration numbers (PF establishment code, ESI employer code, TAN,
PT state) are four new settings in the payroll block of `GET /api/v1/config`
— they appear in the generated settings screen automatically and name the
files.

---

# Part 3 — What to build, in order

1. **Chat UI.** The largest visible hole. Conversation list, thread, composer,
   attachments. Subscribe to `chat.message` (§2.7) — do not poll.
2. **Mail UI.** Folder rail, message list, reading pane, composer, thread view.
   Show delivered-vs-queued honestly on send.
3. **Document upload** on the employee profile, the ticket detail and the chat
   composer — one component, three placements.
4. **Payslip download** on the payslip screen and in the employee's own pay history.
5. **Import wizard** — upload, review, commit.
6. **Settings screen regenerated** from `GET /api/v1/config`, so all 37 keys appear
   without hand-coding.
7. **Tax declaration** — the employee form and the payroll queue (§2.16).
8. **Push opt-in** — service worker, the subscribe button, the devices list
   (§2.17). Small, and it is what makes the phone buzz.
9. **Statutory identifiers on the profile and filings on the run page** (§2.18).
   The `omitted` list is the UX; the download is the easy part. The
   employee form is a one-page form with a live preview; the queue is a table
   with two actions.

## Running it

Three processes, not one: the API, Postgres, and **the scheduler**
(npm run scheduler). Without the scheduler, outbound mail never sends and
inbound mail never arrives — which looks exactly like a broken feature from the
UI. docs/operations.md has the environment, the probes, the backup drill and
what to check when mail is quiet.

Route load-balancer traffic on GET /health/ready, not /health: readiness
answers whether the instance can actually serve, liveness only whether the
process is up.

## What changed underneath since the last brief, and what is still missing

- **Backend gaps closed this round:** Chapter VI-A (§2.16), Web Push (§2.17),
  IMAP IDLE + `mail.received`, S3-compatible document storage, `GET /metrics`,
  and the readiness probe now actually answers in a container.
- **IMAP syncs and pushes.** External mail arrives as well as sends — envelopes
  only, unless the company switches on mail.store_bodies. IDLE is on in the
  scheduler, so a new message triggers a sync within seconds; it lands in the UI
  through the ordinary `mail.received` realtime event, nothing new to subscribe to.
  Over the socket cap it falls back to the five-minute poll.
- **Push exists now** (§2.17). What is NOT there: native iOS/Android apps. Web
  Push covers desktop browsers, Android Chrome, and iOS 16.4+ when the site is
  installed to the home screen.
- **No notification sounds.** When they come: unlock audio on a real user gesture,
  never sound alone as a signal, per-channel tones, default OFF, DND from shift hours.
- **Object storage is a deploy-time switch**, not a UI concern: documents read
  and write the same way whichever backend holds the bytes. Nothing to do.
- **Chapter VI-A is now modelled** (§2.16), but only from a declaration payroll
  has VERIFIED. House property loss, perquisites and marginal relief still are
  not; TDS returns `limitations` stating exactly what it omits. Surface that
  string rather than implying a final tax figure.

## The frontend as you will find it

The screen files were split, so the paths in your editor changed even though no
import did:

```
web/src/Workforce.tsx   -> barrel over workforce/{Attendance,Leave,Approvals}Page.tsx
web/src/People.tsx      -> barrel over people/{PeopleList,EmployeeProfile}.tsx
web/src/Operations.tsx  -> barrel over operations/{Tasks,Announcements,Settings,Reports,Activity}Page.tsx
web/src/App.tsx         -> app/nav.ts (the nav model) + app/screen.tsx (route -> screen)
web/src/styles.css      -> six files in styles/, imported in cascade order
```

**The stylesheet order is load-bearing** — later files deliberately override
earlier ones. Add new rules to `styles/refinements.css` or a new file imported
last, never by reordering the imports.

Two traps that cost me real time:

- **`WidgetBoard` filters children for `Widget` using `Children.toArray`, which
  flattens arrays but NOT fragments or components.** A tile wrapped in a component
  vanishes silently, with no error. Return `Widget` elements from plain functions.
- **A `<button>` with no class slips through every class-based CSS rule.** The
  inactive tab in `Tabs` is exactly that, and it was the last 41px touch target.

Responsive is clean: **eight devices, no horizontal overflow, no target under
44px, no text under the 12px floor.** Avatar initials stay at 11px on purpose —
a graphic inside a circle, not text anyone reads. Keep `npm run check:responsive`
green.

One-viewport fit was not achieved and is a product decision, not a CSS one: 14
tiles cannot fit 900px at readable sizes. The board supports hide/show, so fewer
default tiles is the lever.

## Sanity check

```bash
npm test          # 587 tests, including 33 against the running HTTP API
npm run verify    # every gate, end to end
npm run check:responsive   # eight devices, currently clean
npm run job mail.outbox    # drains queued external mail
npm run smoke              # 59 checks against the RUNNING server (SMOKE_BASE to point elsewhere)
```

If `verify` is green the backend is behaving. If a UI call fails, the error `code`
says why, and it is usually a permission or a module toggle rather than a bug.
