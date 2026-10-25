/**
 * A declaration for a different file than the one a table already lives in is
 * REFUSED, never moved (D851, D853). This is the safety net that turns a deploy
 * to an unconverted hub into a loud failure of ONE addon instead of a silent
 * empty `events.db` beside the real rows.
 */
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { CollectionPlacementError } from '../placement-errors.js'
import { ledgerDeclaration, makeHarness, type Harness } from './support/owned-files-harness.js'

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
})

describe('placement refusal', () => {
  it('refuses events for a table that already lives in settings, naming the script', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('ref:ledger'))
    await router.insert({ collection: 'ref:ledger', record: { id: 'real-row', data: { atMs: 1 } } })

    const refusal = router.declareCollection(ledgerDeclaration('ref:ledger', 'events'))
    await expect(refusal).rejects.toBeInstanceOf(CollectionPlacementError)
    await expect(refusal).rejects.toThrow(/never moves data \(D853\)/)
    await expect(refusal).rejects.toThrow(/"ref:ledger" is in "settings", declared for "events"/)

    // Nothing moved, nothing was created beside the real rows.
    expect(await router.count({ collection: 'ref:ledger' })).toBe(1)
    expect(existsSync(harness.pathOf('events'))).toBe(false)
    expect(router.databaseOf('ref:ledger')).toBe('settings')
    await harness.stopAll(router)
  })

  it('refuses a table that exists in settings without a declaration, too', async () => {
    harness = makeHarness()
    const router = await harness.router()
    // A table created outside any declaration is still a table in that file.
    await harness.stopAll(router)
    const db = new Database(harness.pathOf('settings'))
    db.exec('CREATE TABLE "ref:orphan" (id TEXT PRIMARY KEY, atMs INTEGER)')
    db.close()

    const reopened = await harness.router()
    await expect(
      reopened.declareCollection(ledgerDeclaration('ref:orphan', 'events')),
    ).rejects.toBeInstanceOf(CollectionPlacementError)
    expect(existsSync(harness.pathOf('events'))).toBe(false)
    await harness.stopAll(reopened)
  })

  it('refuses the reverse: a table in events re-declared with no database', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('ref:moved', 'events'))
    await expect(router.declareCollection(ledgerDeclaration('ref:moved'))).rejects.toThrow(
      /"ref:moved" is in "events", declared for "settings"/,
    )
    await harness.stopAll(router)
  })

  it('re-declaring a collection for the file it is already in is idempotent', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('ref:same', 'events'))
    await router.declareCollection(ledgerDeclaration('ref:same', 'events'))
    expect(router.databaseOf('ref:same')).toBe('events')
    await harness.stopAll(router)
  })
})
