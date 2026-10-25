/**
 * D698 — a restart never moves an open system state's "since".
 *
 * The same boot race as the liveness ledger (`liveness-boot-window.spec.ts`):
 * the system-state ledger loads late in the back-fill, and a stream or a
 * switch re-announced at boot used to open a row stamped "now", persisted
 * write-behind over the stored one the load had not read yet.
 */
import { describe, expect, it, vi } from 'vitest'
import type { InMemoryRecords } from '@camstack/types'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import { slowWrites } from '../../__tests__/slow-writes.js'
import { makeNcRecords, ncTable, withNcFaults } from '../../__tests__/support/nc-test-deps.js'
import type { NcSystemEventSubject } from '../../rule-engine.js'
import { NcSystemStateLedger, NcSystemStateStore } from '../system-state-ledger.js'

const SINCE = 1_790_000_000_000
const RESTART = SINCE + 9 * 3_600_000

const STREAM_OFFLINE: NcSystemEventSubject = {
  kind: 'stream-offline',
  subject: 'stream:20',
  deviceId: 20,
  textParams: { deviceName: 'Entrance', profile: 'high' },
  data: {},
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

async function seededWorld(): Promise<InMemoryRecords> {
  const world = makeNcRecords()
  const first = new NcSystemStateStore({
    records: world.records,
    logger: makeSilentLogger(),
  })
  await first.load()
  new NcSystemStateLedger({ rows: first.port() }).observe(STREAM_OFFLINE, SINCE)
  await settle()
  return world
}

function sinceOf(store: NcSystemStateStore): number | undefined {
  return new NcSystemStateLedger({ rows: store.port() })
    .openRows()
    ?.find((row) => row.key === 'stream:20')?.since
}

describe('the system-state ledger across a restart (D698)', () => {
  it('a state re-announced before the load keeps the stored since — in RAM and in the store', async () => {
    const world = await seededWorld()
    const booted = new NcSystemStateStore({
      records: world.records,
      logger: makeSilentLogger(),
    })
    new NcSystemStateLedger({ rows: booted.port() }).observe(STREAM_OFFLINE, RESTART)
    await settle()
    await booted.load()
    expect(sinceOf(booted)).toBe(SINCE)

    const respawned = new NcSystemStateStore({
      records: world.records,
      logger: makeSilentLogger(),
    })
    await respawned.load()
    expect(sinceOf(respawned)).toBe(SINCE)
  })

  it('a state the store never held is written by the load, with the time it was observed', async () => {
    const world = makeNcRecords()
    const booted = new NcSystemStateStore({
      records: world.records,
      logger: makeSilentLogger(),
    })
    new NcSystemStateLedger({ rows: booted.port() }).observe(STREAM_OFFLINE, RESTART)
    await settle()
    expect(ncTable(world, 'system-state')?.size ?? 0).toBe(0)
    await booted.load()
    await settle()
    expect(sinceOf(booted)).toBe(RESTART)
    expect(ncTable(world, 'system-state')?.get('stream:20')?.['since']).toBe(RESTART)
  })

  it('a state CLOSED inside the window is not resurrected by the load', async () => {
    const world = await seededWorld()
    const booted = new NcSystemStateStore({
      records: world.records,
      logger: makeSilentLogger(),
    })
    const ledger = new NcSystemStateLedger({ rows: booted.port() })
    ledger.observe(STREAM_OFFLINE, RESTART)
    ledger.observeStreamOnline(20)
    await booted.load()
    await settle()
    expect(ledger.openRows()).toEqual([])
    expect(ncTable(world, 'system-state')?.has('stream:20') ?? false).toBe(false)
  })
  it('a CLOSE whose delete lands after the load read is not resurrected by the load', async () => {
    const world = await seededWorld()
    const slow = slowWrites(world)
    const booted = new NcSystemStateStore({
      records: slow.world.records,
      logger: makeSilentLogger(),
    })
    const ledger = new NcSystemStateLedger({ rows: booted.port() })
    ledger.observe(STREAM_OFFLINE, RESTART)
    ledger.observeStreamOnline(20)
    await booted.load()
    expect(ledger.openRows()).toEqual([])
    slow.release()
    await settle()
    expect(ncTable(world, 'system-state')?.has('stream:20') ?? false).toBe(false)
  })

  it('H1: a CLOSE heard in the window for a row only the STORE holds closes it at load', async () => {
    const world = await seededWorld()
    const booted = new NcSystemStateStore({ records: world.records, logger: makeSilentLogger() })
    const ledger = new NcSystemStateLedger({ rows: booted.port() })
    // The recreated broker's first packet, before the state-summary phase loads.
    ledger.observeStreamOnline(20)
    await booted.load()
    await settle()
    expect(ledger.openRows()).toEqual([])
    expect(ncTable(world, 'system-state')?.has('stream:20') ?? false).toBe(false)
  })

  it('H1: a predicate close (server-updated) in the window ends the stored rows it names', async () => {
    const world = makeNcRecords()
    const first = new NcSystemStateStore({ records: world.records, logger: makeSilentLogger() })
    await first.load()
    new NcSystemStateLedger({ rows: first.port() }).observeUpdateList(
      {
        target: 'server',
        nodeIds: ['hub'],
        rows: [{ packageName: '@camstack/server', currentVersion: '1', latestVersion: '2' }],
      },
      SINCE,
    )
    await settle()
    const booted = new NcSystemStateStore({ records: world.records, logger: makeSilentLogger() })
    const ledger = new NcSystemStateLedger({ rows: booted.port() })
    ledger.observe(
      { kind: 'server-updated', subject: 'server:hub', nodeId: 'hub', data: {} },
      RESTART,
    )
    await booted.load()
    await settle()
    expect(ledger.openRows()).toEqual([])
  })

  it('H1: a state that CLOSED and then OPENED again in the window is held as the new opening', async () => {
    const world = await seededWorld()
    const booted = new NcSystemStateStore({ records: world.records, logger: makeSilentLogger() })
    const ledger = new NcSystemStateLedger({ rows: booted.port() })
    ledger.observeStreamOnline(20)
    ledger.observe(STREAM_OFFLINE, RESTART)
    await booted.load()
    await settle()
    expect(sinceOf(booted)).toBe(RESTART)
    // …in the STORE too, and a respawn reads it back (review LOW-1).
    expect(ncTable(world, 'system-state')?.get('stream:20')?.['since']).toBe(RESTART)
    const respawned = new NcSystemStateStore({ records: world.records, logger: makeSilentLogger() })
    await respawned.load()
    expect(sinceOf(respawned)).toBe(RESTART)
  })

  it('LOW-2/3: a replayed close is SAID — INFO with the deviceId tag — and the settle counts ROWS closed', async () => {
    const world = await seededWorld()
    const logger = makeSilentLogger()
    const info = vi.spyOn(logger, 'info')
    const booted = new NcSystemStateStore({ records: world.records, logger })
    const ledger = new NcSystemStateLedger({ rows: booted.port(), logger })
    ledger.observeStreamOnline(20)
    // Detections on a camera with nothing open: deferred, and close nothing.
    for (let i = 0; i < 5; i += 1) ledger.observeDetection(99 + i)
    await booted.load()
    expect(info).toHaveBeenCalledWith('system state closed by an event heard before the load', {
      tags: { deviceId: 20 },
      meta: expect.objectContaining({ key: 'stream:20', by: 'stream-online' }),
    })
    expect(info).toHaveBeenCalledWith('boot window settled', {
      meta: {
        collection: 'notification-center:system-state',
        keptStored: 0,
        written: 0,
        replayed: 1,
      },
    })
  })

  // pendingCloses is 2: the stream.online AND the one-time close of the pre-D883
  // per-cam-stream keys that every ledger registers when it is built.
  it('LOW-3: a load that FAILS says how many closes are left pending', async () => {
    const world = await seededWorld()
    const logger = makeSilentLogger()
    const warn = vi.spyOn(logger, 'warn')
    const booted = new NcSystemStateStore({
      records: withNcFaults(world, { read: () => 'settings store unavailable' }).records,
      logger,
    })
    new NcSystemStateLedger({ rows: booted.port(), logger }).observeStreamOnline(20)
    await booted.load()
    expect(warn).toHaveBeenCalledWith('boot window NOT settled — the load did not answer', {
      meta: {
        collection: 'notification-center:system-state',
        pendingCloses: 2,
        provisionalRows: 0,
      },
    })
  })

  it('M1: the stored since survives, the FRESH facts are taken', async () => {
    const world = await seededWorld()
    const booted = new NcSystemStateStore({ records: world.records, logger: makeSilentLogger() })
    new NcSystemStateLedger({ rows: booted.port() }).observe(
      { ...STREAM_OFFLINE, textParams: { deviceName: 'Front door', profile: 'high' } },
      RESTART,
    )
    await booted.load()
    await settle()
    const row = new NcSystemStateLedger({ rows: booted.port() })
      .openRows()
      ?.find((r) => r.key === 'stream:20')
    expect(row?.since).toBe(SINCE)
    expect(row?.params['deviceName']).toBe('Front door')
  })
})
