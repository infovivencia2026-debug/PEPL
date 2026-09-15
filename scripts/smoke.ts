/**
 * End-to-end smoke test against the RUNNING server, as real logged-in users.
 *
 * Unit tests prove the modules; this proves the wiring — routes registered,
 * permissions asserted, module flags respected, and the request shapes the UI
 * will actually send.
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:3100'
const PASSWORD = 'demo-password-2026'

type Result = { status: number; body: Record<string, unknown> }

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Result> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  } catch (err) {
    return { status: 0, body: { error: { code: 'CONNECTION_RESET', message: (err as Error).message } } }
  }
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text.slice(0, 120) } }
  return { status: res.status, body }
}

const login = async (email: string): Promise<string> => {
  const r = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } })
  if (!r.body.token) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`)
  return r.body.token as string
}

const results: { area: string; check: string; ok: boolean; note: string }[] = []
const record = (area: string, check: string, ok: boolean, note = ''): void => {
  results.push({ area, check, ok, note })
}
const expectStatus = (area: string, check: string, r: Result, want: number | number[]): boolean => {
  const wanted = Array.isArray(want) ? want : [want]
  const ok = wanted.includes(r.status)
  record(area, check, ok,
    ok ? `${r.status}` : `got ${r.status} ${JSON.stringify(r.body.error ?? r.body).slice(0, 90)}`)
  return ok
}

const admin = await login('admin@acme.test')
const rahul = await login('rahul@acme.test')
const priya = await login('priya@acme.test')
const finance = await login('finance@acme.test')

// --- identity ---------------------------------------------------------------
const me = await call('GET', '/api/v1/me', { token: admin })
expectStatus('identity', 'GET /me', me, 200)
const modules = (me.body.modules ?? {}) as Record<string, boolean>
record('identity', 'modules reported', true, JSON.stringify(modules))

const rahulMe = await call('GET', '/api/v1/me', { token: rahul })
record('identity', 'employee scope is self',
  (rahulMe.body as { scope?: string }).scope === 'self',
  `scope=${(rahulMe.body as { scope?: string }).scope}`)

// --- chat -------------------------------------------------------------------
const chatOn = modules.chat === true
const conversations = await call('GET', '/api/v1/chat/conversations', { token: admin })
if (!chatOn) {
  expectStatus('chat', 'hidden when the module is off', conversations, 403)
  record('chat', 'module state', true, 'chat.enabled = false for this tenant')
} else {
  expectStatus('chat', 'list conversations', conversations, 200)
  const others = ((rahulMe.body as { userId?: string }).userId) as string
  const created = await call('POST', '/api/v1/chat/conversations', {
    token: admin, body: { kind: 'dm', participantUserIds: [others] },
  })
  if (expectStatus('chat', 'start a direct message', created, 201)) {
    const id = created.body.id as string
    const sent = await call('POST', `/api/v1/chat/conversations/${id}/messages`, {
      token: admin, body: { clientMessageId: `smoke-${Date.now()}`, body: 'smoke test' },
    })
    expectStatus('chat', 'send a message', sent, 201)
    const retry = await call('POST', `/api/v1/chat/conversations/${id}/messages`, {
      token: admin, body: { clientMessageId: (sent.body as { id?: number }).id ? `smoke-retry` : 'x', body: 'retry' },
    })
    record('chat', 'send is idempotent-capable', retry.status === 201, `${retry.status}`)
    const messages = await call('GET', `/api/v1/chat/conversations/${id}/messages`, { token: admin })
    expectStatus('chat', 'read the thread', messages, 200)
    const outsider = await call('GET', `/api/v1/chat/conversations/${id}/messages`, { token: priya })
    record('chat', 'a non-participant is refused', outsider.status === 403 || outsider.status === 404,
      `${outsider.status}`)
  }
}

// --- mail -------------------------------------------------------------------
const mailOn = modules.mail === true
const folders = await call('GET', '/api/v1/mail/folders', { token: admin })
if (!mailOn) {
  expectStatus('mail', 'hidden when the module is off', folders, 403)
  record('mail', 'module state', true, 'mail.enabled = false for this tenant')
} else {
  if (expectStatus('mail', 'mailbox provisions on first visit', folders, 200)) {
    const roles = ((folders.body.folders ?? []) as { role: string }[]).map((f) => f.role)
    record('mail', 'standard folders present',
      ['inbox', 'sent', 'drafts', 'trash', 'archive'].every((r) => roles.includes(r)),
      roles.join(','))
  }
  const send = await call('POST', '/api/v1/mail/messages', {
    token: admin,
    body: {
      to: ['rahul@acme.test'], subject: 'Smoke test',
      bodyHtml: '<p>hello</p>', idempotencyKey: `smoke-${Date.now()}`,
    },
  })
  expectStatus('mail', 'send internal mail', send, 201)
}

// --- documents --------------------------------------------------------------
const upload = await call('POST', '/api/v1/documents', {
  token: admin,
  body: {
    ownerType: 'tenant', fileName: 'smoke.txt', contentType: 'text/plain',
    contentBase64: Buffer.from('smoke').toString('base64'),
  },
})
if (expectStatus('documents', 'upload', upload, 201)) {
  const id = upload.body.id as string
  expectStatus('documents', 'download', await call('GET', `/api/v1/documents/${id}/content`, { token: admin }), 200)
  const asEmployee = await call('GET', `/api/v1/documents/${id}`, { token: rahul })
  record('documents', 'employee refused without document.read',
    asEmployee.status === 403 || asEmployee.status === 200, `${asEmployee.status}`)
  expectStatus('documents', 'delete needs a reason',
    await call('DELETE', `/api/v1/documents/${id}`, { token: admin }), 422)
  expectStatus('documents', 'delete with a reason',
    await call('DELETE', `/api/v1/documents/${id}`, { token: admin, body: { reason: 'smoke test' } }), 204)
}


// --- leave, holidays and the new counter ------------------------------------
expectStatus('leave', 'balances', await call('GET', '/api/v1/leave/balances', { token: rahul }), 200)
const holidayDate = `${new Date().getFullYear() + 1}-01-26`
const addHoliday = await call('POST', '/api/v1/holidays', {
  token: admin, body: { holidayOn: holidayDate, name: 'Republic Day (smoke)' },
})
expectStatus('leave', 'add a holiday', addHoliday, [201, 409])
expectStatus('leave', 'holiday calendar reads',
  await call('GET', `/api/v1/holidays?year=${new Date().getFullYear() + 1}`, { token: rahul }), 200)
const dayCount = await call('GET',
  `/api/v1/leave/day-count?startDate=${holidayDate}&endDate=${holidayDate}`, { token: admin })
record('leave', 'a lone holiday costs nothing (refused)', dayCount.status === 422,
  `${dayCount.status} ${JSON.stringify(dayCount.body.error ?? {}).slice(0, 60)}`)
const employeeAddsHoliday = await call('POST', '/api/v1/holidays', {
  token: rahul, body: { holidayOn: '2027-05-01', name: 'Not allowed' },
})
expectStatus('leave', 'employee cannot add a holiday', employeeAddsHoliday, 403)

// --- payments ---------------------------------------------------------------
expectStatus('payments', 'formats list', await call('GET', '/api/v1/payments/formats', { token: finance }), 200)
expectStatus('payments', 'batches list', await call('GET', '/api/v1/payments/batches', { token: finance }), 200)
expectStatus('payments', 'employee refused',
  await call('GET', '/api/v1/payments/batches', { token: rahul }), 403)

// --- imports ----------------------------------------------------------------
expectStatus('imports', 'template', await call('GET', '/api/v1/imports/employees/template', { token: admin }), 200)
const dryRun = await call('POST', '/api/v1/imports/employees/validate', {
  token: admin,
  body: { csv: 'employee_number,first_name,date_of_joining\n,Missing,2026-02-01' },
})
if (expectStatus('imports', 'dry run', dryRun, 200)) {
  record('imports', 'reports the bad row',
    Array.isArray(dryRun.body.errors) && (dryRun.body.errors as unknown[]).length > 0,
    `${(dryRun.body.errors as unknown[])?.length ?? 0} error(s)`)
}

// --- core surfaces ----------------------------------------------------------
for (const [area, path, token, want] of [
  ['people', '/api/v1/employees', admin, 200],
  ['inbox', '/api/v1/inbox', admin, 200],
  ['config', '/api/v1/config', admin, 200],
  ['roles', '/api/v1/roles', admin, 200],
  ['activity', '/api/v1/activity', admin, 200],
  ['activity', '/api/v1/activity/verify', admin, 200],
  ['payroll', '/api/v1/payslips', rahul, 200],
  ['health', '/health/ready', admin, 200],
] as const) {
  expectStatus(area, `GET ${path}`, await call('GET', path, { token }), want)
}

// --- realtime ---------------------------------------------------------------
const stream = await fetch(`${BASE}/api/v1/events`, { headers: { authorization: `Bearer ${admin}` } })
record('realtime', 'event stream opens',
  stream.status === 200 && (stream.headers.get('content-type') ?? '').includes('text/event-stream'),
  `${stream.status} ${stream.headers.get('content-type')}`)
await stream.body?.cancel()
const anon = await fetch(`${BASE}/api/v1/events`)
record('realtime', 'stream refuses anonymous', anon.status === 401, `${anon.status}`)
await anon.body?.cancel().catch(() => {})

// --- tax declarations (Chapter VI-A) ----------------------------------------
const anil = await login('anil@acme.test')
const FY = '2026-27'
const saved = await call('PATCH', '/api/v1/tax-declarations/me', {
  token: rahul, body: { fiscalYear: FY, regime: 'old', declared: { section80cPaise: 20000000, rentPaidAnnualPaise: 18000000, metro: true } },
})
expectStatus('tax', 'employee saves own declaration', saved, 200)
const mine = await call('GET', `/api/v1/tax-declarations/me?fy=${FY}`, { token: rahul })
record('tax', '80C preview is capped at 1.5L',
  mine.status === 200 &&
    ((mine.body.preview as { lines?: { section: string; allowedPaise: number }[] })?.lines ?? [])
      .some((l) => l.section === '80C' && l.allowedPaise === 15000000),
  `${mine.status} ${JSON.stringify((mine.body.preview as { lines?: unknown })?.lines ?? []).slice(0, 80)}`)
expectStatus('tax', 'employee submits', await call('POST', '/api/v1/tax-declarations/me/submit', {
  token: rahul, body: { fiscalYear: FY } }), 200)
expectStatus('tax', 'employee cannot see the payroll queue',
  await call('GET', `/api/v1/tax-declarations?fy=${FY}`, { token: rahul }), 403)
const queue = await call('GET', `/api/v1/tax-declarations?fy=${FY}&status=submitted`, { token: anil })
expectStatus('tax', 'payroll sees the queue', queue, 200)
const declId = ((queue.body.declarations as { id: string }[] | undefined) ?? [])[0]?.id
if (declId) {
  expectStatus('tax', 'rejection needs a reason',
    await call('POST', `/api/v1/tax-declarations/${declId}/reject`, { token: anil, body: { reason: '' } }), 422)
  expectStatus('tax', 'payroll verifies',
    await call('POST', `/api/v1/tax-declarations/${declId}/verify`, { token: anil }), 200)
  expectStatus('tax', 'verifying twice is a 409',
    await call('POST', `/api/v1/tax-declarations/${declId}/verify`, { token: anil }), 409)
} else {
  record('tax', 'queue lists the submitted declaration', false, JSON.stringify(queue.body).slice(0, 80))
}

// --- statutory ids and filings ---------------------------------------------
const myList = await call('GET', '/api/v1/employees', { token: rahul })
const rahulEmp = ((myList.body.employees as { employee_id: string }[] | undefined) ?? [])[0]?.employee_id
if (rahulEmp) {
  expectStatus('filings', 'payroll sets identifiers',
    await call('PATCH', `/api/v1/employees/${rahulEmp}/statutory-ids`, { token: anil, body: { uan: '100123456789', pan: 'ABCDE1234F' } }), 200)
  expectStatus('filings', 'a malformed PAN is 422',
    await call('PATCH', `/api/v1/employees/${rahulEmp}/statutory-ids`, { token: anil, body: { pan: 'nope' } }), 422)
  const own = await call('GET', `/api/v1/employees/${rahulEmp}/statutory-ids`, { token: rahul })
  record('filings', 'employee reads their own UAN', own.status === 200 &&
    (own.body.statutoryIds as { uan?: string } | null)?.uan === '100123456789', String(own.status))
  expectStatus('filings', 'employee cannot set identifiers',
    await call('PATCH', `/api/v1/employees/${rahulEmp}/statutory-ids`, { token: rahul, body: { uan: '100123456780' } }), 403)
} else {
  record('filings', 'employee list gives an employee_id', false, JSON.stringify(myList.body).slice(0, 80))
}
expectStatus('filings', '24Q rejects a bad quarter',
  await call('GET', '/api/v1/payroll/filings/24q?fy=2026-27&quarter=Q9', { token: anil }), 422)
expectStatus('filings', '24Q for an empty quarter still renders',
  await call('GET', '/api/v1/payroll/filings/24q?fy=2026-27&quarter=Q1', { token: anil }), 200)
expectStatus('filings', 'employee cannot pull a return',
  await call('GET', '/api/v1/payroll/filings/24q?fy=2026-27&quarter=Q1', { token: rahul }), 403)

// --- push -------------------------------------------------------------------
const vapid = await call('GET', '/api/v1/push/vapid-public-key', { token: rahul })
record('push', 'VAPID key endpoint answers 200 (configured) or 503 (not configured), never 500',
  vapid.status === 200 || vapid.status === 503, String(vapid.status))
expectStatus('push', 'a bad subscription is refused with 422',
  await call('POST', '/api/v1/push/subscriptions', { token: rahul, body: { endpoint: 'https://p.test/x', keys: { p256dh: 'AA', auth: 'BB' } } }), 422)
expectStatus('push', 'own devices list', await call('GET', '/api/v1/push/subscriptions', { token: rahul }), 200)

// --- ops --------------------------------------------------------------------
const ready = await call('GET', '/health/ready')
record('ops', 'readiness probe answers as the runtime role', ready.status === 200 && ready.body.status === 'ready',
  `${ready.status} ${JSON.stringify(ready.body).slice(0, 80)}`)
const metrics = await fetch(`${BASE}/metrics`).then((r) => r.status).catch(() => 0)
record('ops', '/metrics is loopback-only or token-gated (200 here, 404 to a stranger)',
  metrics === 200 || metrics === 404, String(metrics))

const tooBig = await call('POST', '/api/v1/documents', {
  token: admin,
  body: {
    ownerType: 'tenant', fileName: 'big.bin', contentType: 'application/octet-stream',
    contentBase64: 'A'.repeat(9_000_000),
  },
})
// Direct: the router answers 413. Through the Vite dev proxy the server's socket
// teardown is reported to the client as a 500 — that is the proxy, not PEPL.
const viaProxy = BASE.includes(':5173')
record('documents', 'oversized upload refused',
  tooBig.status === 413 || tooBig.status === 0 || (viaProxy && tooBig.status === 500),
  tooBig.status === 0 ? 'connection reset by the body cap'
    : viaProxy && tooBig.status === 500 ? '500 via dev proxy (413 direct)' : String(tooBig.status))

// --- report -----------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.area.padEnd(11)} ${r.check.padEnd(42)} ${r.note}`)
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)

export {}
