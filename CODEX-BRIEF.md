# PEPL — full brief for the UI build

This supersedes `API-HANDOFF.md` and contains it. Part 1 is the original handoff,
corrected where the backend has moved on. Part 2 is everything built since. Part 3
is what to build next and what is still genuinely missing.

The backend is complete and tested for every feature described here: **366 tests,
88 routes, 19 launch checks, all green in one run.**

---

# Part 0 — Run it

```bash
npm install
npm run db:setup      # roles + database + extensions (needs a local Postgres)
npm run migrate       # 24 migrations
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
this response** rather than hand-coding forms — there are now 34 settings and new
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

## 2.7 Settings that now exist

Nine new keys, all generated into the settings screen automatically:

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

---

# Part 3 — What to build, in order

1. **Chat UI.** The largest visible hole. Conversation list, thread, composer,
   attachments. Poll `GET /chat/conversations` on an interval — there is no socket yet
   (see below), so keep the interval modest and pause it when the tab is hidden.
2. **Mail UI.** Folder rail, message list, reading pane, composer, thread view.
3. **Document upload** on the employee profile, the ticket detail and the chat
   composer — one component, three placements.
4. **Payslip download** on the payslip screen and in the employee's own pay history.
5. **Import wizard** — upload, review, commit.
6. **Settings screen regenerated** so the nine new keys appear without hand-coding.

## Still genuinely missing — do not design around these as if present

- **No realtime transport.** Chat and notifications are polled. A socket or SSE layer
  is the next backend slice.
- **No SMTP/IMAP worker.** External mail queues correctly and is never lost, but
  nothing drains the queue yet, and external mail does not arrive. Internal mail works
  end to end. The UI must show queued-vs-delivered honestly.
- **No email or push delivery** of notifications; they are stored and readable.
- **No notification sounds.** When they come: unlock audio on a real user gesture,
  never sound alone as a signal, per-channel tones, default OFF, DND from shift hours.
- **No object storage.** Document bytes live in Postgres behind a `storage` column, so
  the swap is a value and a reader branch, not a migration.
- **Chapter VI-A deductions** (80C, 80D, HRA exemption) are not modelled; TDS is a
  real projection against real slabs, with `limitations` stating exactly what it
  omits. Surface that string rather than implying a final tax figure.

## Frontend housekeeping I have not done

- `web/src/Workforce.tsx` (672), `App.tsx` (606), `People.tsx` (534),
  `Operations.tsx` (492), `Payroll.tsx` (399) and `styles.css` (~4,400) are still
  single large files. `Dashboard.tsx` shows the pattern to follow: tiles as
  element-returning functions in `web/src/dashboard/`, arithmetic in a pure
  `metrics.ts`, the screen file reduced to arrangement.
- **`WidgetBoard` filters children for `Widget` using `Children.toArray`, which
  flattens arrays but NOT fragments or components.** A tile wrapped in a component
  vanishes silently, with no error. Return `Widget` elements from plain functions.
- Two residual responsive items: an 11px text run on phones (target 12px) and one
  41px button on iPad Pro (target 44px).
- One-viewport fit was not achieved and is a product decision, not a CSS one: 14
  tiles cannot fit 900px at readable sizes. The board supports hide/show, so fewer
  default tiles is the lever.

## Sanity check

```bash
npm test          # 366 tests, including 33 against the running HTTP API
npm run verify    # every gate, end to end
```

If `verify` is green the backend is behaving. If a UI call fails, the error `code`
says why, and it is usually a permission or a module toggle rather than a bug.
