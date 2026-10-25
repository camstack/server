/**
 * Every list this page WRITES to, it also invalidates.
 *
 * ## The report this closes (operator, 2026-09-16)
 *
 * "Quando creo una zona la admin ui non si aggiorna automaticamente."
 * [In English: "When I create a zone the admin UI does not update by itself."]
 *
 * Exactly right, and it was two lists, not one: `listSiteZones` and
 * `listLocationDescriptions` were both added to this page without being added
 * to `invalidate`. The page mutated the server and kept rendering the answer it
 * had cached before the mutation — a zone created and invisible, which reads as
 * "the button did nothing".
 *
 * The shape of the bug is what makes it worth a guard rather than a fix: the
 * mutation and the invalidation are in two places, and adding a feature touches
 * the first. Nothing made the second fail. So this asserts, on the source, that
 * every `deviceManager.list*` this page READS is also invalidated after a write
 * — a list you render and never refresh is a list that goes stale the first
 * time someone changes it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(path.resolve(HERE, '../../Locations.tsx'), 'utf8')

/** The `listX` names this page subscribes to, from its `useDeviceManagerListX`
 *  hooks — derived, so a new hook is covered the day it is added. */
function listsRead(): readonly string[] {
  return [...SOURCE.matchAll(/useDeviceManagerList(\w+)\(/g)].map(
    (m) => m[1].charAt(0).toLowerCase() + m[1].slice(1),
  )
}

/** The `listX` names passed to `invalidateQueries`. */
function listsInvalidated(): readonly string[] {
  return [...SOURCE.matchAll(/\['deviceManager',\s*'(list\w+)'\]/g)].map(
    (m) => m[1].charAt(4).toLowerCase() + m[1].slice(5),
  )
}

describe('the Locations page refreshes what it writes to', () => {
  it('reads at least the four lists this page is built on', () => {
    // A canary: if the hooks are renamed this spec must be updated rather than
    // silently start asserting nothing.
    expect(listsRead().length).toBeGreaterThanOrEqual(4)
  })

  it('invalidates every list it reads', () => {
    const missing = listsRead().filter((name) => !listsInvalidated().includes(name))
    expect(missing, `not invalidated after a write: ${missing.join(', ')}`).toEqual([])
  })
})
