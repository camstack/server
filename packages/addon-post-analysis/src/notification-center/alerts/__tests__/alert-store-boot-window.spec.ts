/**
 * The alert ledger's BOOT WINDOW (D698 applied to D636's rows): a battery
 * raise heard before the back-fill read the ledger must survive that read.
 * The load REPLACES the mirror, so without the window a pending raise written
 * in the gap was wiped and never re-offered.
 */
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import { makeNcRecords, ncTable } from '../../__tests__/support/nc-test-deps.js'
import type { NcAlertRow } from '../alert-episode.js'
import { mergeBootWindowAlertRow, NcAlertStore } from '../alert-store.js'

const PENDING: NcAlertRow = {
  subject: 'battery:3615',
  alerting: true,
  since: 2_000,
  lastNotifiedAt: 0,
  reminders: 0,
}

describe('mergeBootWindowAlertRow', () => {
  it('nothing stored → the provisional row', () => {
    expect(mergeBootWindowAlertRow(undefined, PENDING)).toBe(PENDING)
  })

  it('a different state → the provisional row (the condition moved while down)', () => {
    const stored: NcAlertRow = { ...PENDING, alerting: false, since: 1_000 }
    expect(mergeBootWindowAlertRow(stored, PENDING)).toBe(PENDING)
  })

  it('the same state, nothing newer said → the stored episode keeps its since', () => {
    const stored: NcAlertRow = { ...PENDING, since: 1_000, lastNotifiedAt: 1_000 }
    expect(mergeBootWindowAlertRow(stored, PENDING)).toBe(stored)
  })

  it('the same state, spoken about more recently → the provisional row', () => {
    const stored: NcAlertRow = { ...PENDING, since: 1_000, lastNotifiedAt: 1_000 }
    const spoken: NcAlertRow = { ...PENDING, lastNotifiedAt: 2_000 }
    expect(mergeBootWindowAlertRow(stored, spoken)).toBe(spoken)
  })
})

describe('NcAlertStore boot window', () => {
  it('a row put before the load survives the load, and is persisted at the settle', async () => {
    const world = makeNcRecords()
    const alerts = new NcAlertStore({ records: world.records, logger: makeSilentLogger() })
    const port = alerts.port()
    port.put(PENDING)
    // Staged, readable, but NOT persisted yet.
    expect(port.get(PENDING.subject)).toEqual(PENDING)
    expect(ncTable(world, 'device-alerts')?.size ?? 0).toBe(0)

    await alerts.load()

    expect(port.get(PENDING.subject)).toEqual(PENDING)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(ncTable(world, 'device-alerts')?.has(PENDING.subject)).toBe(true)
  })

  it('a stored episode of the same state is kept over a pending row heard at boot', async () => {
    const world = makeNcRecords()
    const announced: NcAlertRow = { ...PENDING, since: 1_000, lastNotifiedAt: 1_000 }
    const before = new NcAlertStore({ records: world.records, logger: makeSilentLogger() })
    await before.load()
    before.port().put(announced)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    const after = new NcAlertStore({ records: world.records, logger: makeSilentLogger() })
    after.port().put(PENDING)
    await after.load()
    expect(after.port().get(PENDING.subject)).toEqual(announced)
  })
})
