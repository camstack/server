/**
 * A `migrate` message reaches the file-host WORKER (D986): `events.db` is
 * served off the main thread, so the ledger must be created and answered there.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { openOwnedSqliteFile } from '../owned-sqlite-file.js'
import { makeHarness, type Harness } from './support/owned-files-harness.js'

let h: Harness | null = null
afterEach(() => {
  h?.cleanup()
  h = null
})

describe('migrate over the file-host worker', () => {
  it('creates the _migrations ledger in events.db and answers it empty', async () => {
    h = makeHarness()
    const events = await openOwnedSqliteFile(h.specOf('events'), h.deps)
    try {
      const prepared = await events.migrate('prepare', { external: {}, held: [] })
      expect(prepared.runnable).toEqual([])
      expect(await events.migrate('ledger', {})).toEqual([])
      expect(await events.hasTable('_migrations')).toBe(true)
    } finally {
      await events.stop()
    }
  }, 60_000)
})
