/**
 * The navigation must not advertise what the user cannot open.
 *
 * Found by walking the product as each demo role: an employee saw a "Growth"
 * item whose screen answered 403, because the entry declared no permission.
 * The same entry declared no module either -- and learning is a SOLD
 * entitlement, so a customer on a plan without it was being shown a door to a
 * room they had not bought. `chat` and `mail` had the same hole.
 *
 * Read as text on purpose: nav.ts imports icon components, and this assertion
 * is about the declaration, not the rendering.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const NAV = readFileSync('web/src/app/nav.ts', 'utf8')

/** Nav ids that correspond to a sellable module in the config registry. */
const MODULE_BACKED: Record<string, string> = {
  growth: 'learning',
  performance: 'performance',
  hiring: 'recruitment',
  chat: 'chat',
  mail: 'mail',
  documents: 'documents',
  attendance: 'attendance',
  leave: 'leave',
}

/**
 * The declaration block for one entry. Some are written on a single line and
 * some span several, so this reads from the id to the end of that object --
 * a line-at-a-time match silently missed the multi-line ones and reported a
 * defect that was not there.
 */
const entryFor = (id: string): string => {
  const lines = NAV.split('\n')
  const start = lines.findIndex((l) => l.includes(`id: '${id}'`))
  if (start === -1) throw new Error(`no nav entry for '${id}' -- if it was renamed, update this test`)
  if (lines[start]!.trimEnd().endsWith('},')) return lines[start]!
  const rest = lines.slice(start)
  const end = rest.findIndex((l) => l.trim() === '},')
  return rest.slice(0, end === -1 ? 1 : end + 1).join('\n')
}

describe('a sellable module is declared on its nav entry', () => {
  for (const [id, module] of Object.entries(MODULE_BACKED)) {
    it(`${id} declares module: '${module}'`, () => {
      // Without this the item renders for every tenant, including those whose
      // plan does not include the module.
      expect(entryFor(id)).toContain(`module: '${module}'`)
    })
  }
})

describe('an item that needs a permission declares it', () => {
  // These open screens whose API routes assert a permission not every role
  // holds. An undeclared permission means the item shows and then 403s.
  for (const [id, permission] of Object.entries({
    growth: 'learning.read',
    performance: 'performance.read',
    hiring: 'recruit.read',
  })) {
    it(`${id} declares ${permission}`, () => {
      expect(entryFor(id)).toContain(`permission: '${permission}'`)
    })
  }
})
