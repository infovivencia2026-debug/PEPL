/**
 * Operator tool for the public trust page's incident list. Runs on the
 * control connection; there is deliberately no tenant route for this.
 *
 *   npm run incident -- open  <degraded|partial_outage|major_outage|maintenance> "title" ["first note"]
 *   npm run incident -- update <id> "note"
 *   npm run incident -- resolve <id> "closing note"
 *   npm run incident -- list
 */
import { postIncident, updateIncident, incidents } from '../src/control-plane/trust.ts'
import { controlDb } from '../src/control-plane/index.ts'

const [cmd, a, b, c] = process.argv.slice(2)
try {
  if (cmd === 'open' && a && b) console.log(await postIncident({ severity: a as 'degraded', title: b, note: c }))
  else if (cmd === 'update' && a && b) { await updateIncident({ id: a, note: b }); console.log('updated') }
  else if (cmd === 'resolve' && a && b) { await updateIncident({ id: a, note: b, resolved: true }); console.log('resolved') }
  else if (cmd === 'list') console.log(JSON.stringify(await incidents(50), null, 2))
  else { console.error('usage: incident open <severity> "title" ["note"] | update <id> "note" | resolve <id> "note" | list'); process.exitCode = 2 }
} finally { await controlDb.end() }
