/**
 * D698 — a restart never moves an open liveness state's "since".
 *
 * ## The bug this pins (measured on the hub, 2026-10-01)
 *
 * Five sensors offline since 10:36. The hub restarted at 19:43 after a server
 * update. The first state-summary preview afterwards said "offline (since
 * 10:36)" for four of them and "since 19:43" for the fifth; a preview an hour
 * later said 19:43 for all five.
 *
 * The providers re-announce their devices at boot, and the notification
 * centre receives those events while its boot back-fill is still reading the
 * device directory — BEFORE the liveness ledger's `load`. The mirror is empty
 * then, so each `device.offline` SEEDED a row stamped "now" (19:43) and
 * persisted it write-behind. The load then REPLACED the mirror with what the
 * store held: 10:36 where the seed's write had not landed yet, 19:43 where it
 * had. Either way the store now held 19:43, and the next load — the next
 * runner respawn — read 19:43 for every one of them.
 *
 * `updatedAt` is the summary's "since" (`state-sources.ts`), so the fix is the
 * ledger's: an observation made before the load ANSWERED is provisional.
 */
import { describe, expect, it, vi } from 'vitest'
import type { InMemoryRecords } from '@camstack/types'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { slowWrites } from './slow-writes.js'
import { NcLivenessLedger, type NcLivenessObservation } from '../liveness-ledger.js'
import { makeNcRecords, ncTable, withNcFaults } from './support/nc-test-deps.js'

const OFFLINE_SINCE = 1_790_000_000_000 // 10:36, before the restart
const RESTART = OFFLINE_SINCE + 9 * 3_600_000 // 19:43

function device(deviceId: number, online: boolean): NcLivenessObservation {
  return {
    subject: `device:${deviceId}`,
    kind: online ? 'device-online' : 'device-offline',
    state: online ? 'online' : 'offline',
    deviceId,
  }
}

/** Let every write-behind persist land, as a live process would before its load reads. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

function worldWith(
  rows: readonly {
    readonly id: number
    readonly state: 'online' | 'offline'
    readonly at: number
  }[],
): InMemoryRecords {
  const world = makeNcRecords()
  for (const row of rows) {
    world.seed('liveness', {
      id: `device:${row.id}`,
      deviceId: row.id,
      data: {
        state: row.state,
        kind: row.state === 'online' ? 'device-online' : 'device-offline',
        deviceId: row.id,
        updatedAt: row.at,
      },
    })
  }
  return world
}

function updatedAtOf(ledger: NcLivenessLedger, deviceId: number): number | undefined {
  return ledger.snapshot().find((row) => row.subject === `device:${deviceId}`)?.updatedAt
}

describe('the liveness ledger across a restart (D698)', () => {
  it('THE HUB: an offline re-announced before the load keeps the stored since — in RAM and in the store', async () => {
    const ids = [701, 702, 703, 704, 705]
    const world = worldWith(ids.map((id) => ({ id, state: 'offline', at: OFFLINE_SINCE })))

    // The restarted process: the providers re-announce before the back-fill
    // reaches the liveness phase.
    const booted = new NcLivenessLedger({
      records: world.records,
      logger: makeSilentLogger(),
    })
    for (const id of ids) expect(booted.observe(device(id, false), RESTART)).toBe('seeded')
    await settle()
    await booted.load()
    for (const id of ids) expect(updatedAtOf(booted, id)).toBe(OFFLINE_SINCE)

    // …and the NEXT load (a runner respawn an hour later) reads the same.
    const respawned = new NcLivenessLedger({
      records: world.records,
      logger: makeSilentLogger(),
    })
    await respawned.load()
    for (const id of ids) expect(updatedAtOf(respawned, id)).toBe(OFFLINE_SINCE)
  })

  it('a state that CHANGED while the process was down is written, with the time it was observed', async () => {
    const world = worldWith([{ id: 710, state: 'online', at: OFFLINE_SINCE }])
    const booted = new NcLivenessLedger({
      records: world.records,
      logger: makeSilentLogger(),
    })
    expect(booted.observe(device(710, false), RESTART)).toBe('seeded')
    await booted.load()
    await settle()
    expect(booted.stateOf('device:710')).toBe('offline')
    expect(updatedAtOf(booted, 710)).toBe(RESTART)
    const respawned = new NcLivenessLedger({
      records: world.records,
      logger: makeSilentLogger(),
    })
    await respawned.load()
    expect(respawned.stateOf('device:710')).toBe('offline')
  })

  it('a subject the store never held is written by the load, not before it', async () => {
    const world = worldWith([])
    const booted = new NcLivenessLedger({
      records: world.records,
      logger: makeSilentLogger(),
    })
    booted.observe(device(720, false), RESTART)
    await settle()
    expect(ncTable(world, 'liveness')?.has('device:720') ?? false).toBe(false)
    await booted.load()
    await settle()
    expect(ncTable(world, 'liveness')?.get('device:720')?.['updatedAt']).toBe(RESTART)
  })

  it('a real FLIP inside the boot window survives the load — it is newer than the store', async () => {
    const world = worldWith([{ id: 730, state: 'offline', at: OFFLINE_SINCE }])
    const booted = new NcLivenessLedger({
      records: world.records,
      logger: makeSilentLogger(),
    })
    expect(booted.observe(device(730, false), RESTART)).toBe('seeded')
    expect(booted.observe(device(730, true), RESTART + 60_000)).toBe('flip')
    await booted.load()
    expect(booted.stateOf('device:730')).toBe('online')
    expect(updatedAtOf(booted, 730)).toBe(RESTART + 60_000)
    await settle()
    const respawned = new NcLivenessLedger({
      records: world.records,
      logger: makeSilentLogger(),
    })
    await respawned.load()
    expect(respawned.stateOf('device:730')).toBe('online')
  })

  it('a FLIP whose write lands after the load read is not regressed to the stored row', async () => {
    const world = worldWith([{ id: 731, state: 'offline', at: OFFLINE_SINCE }])
    const slow = slowWrites(world)
    const booted = new NcLivenessLedger({
      records: slow.world.records,
      logger: makeSilentLogger(),
    })
    booted.observe(device(731, false), RESTART)
    expect(booted.observe(device(731, true), RESTART + 60_000)).toBe('flip')
    await booted.load()
    expect(booted.stateOf('device:731')).toBe('online')
    expect(updatedAtOf(booted, 731)).toBe(RESTART + 60_000)
    slow.release()
  })

  it('a load that FAILS writes nothing provisional — the store it could not read is not overwritten', async () => {
    const world = worldWith([{ id: 740, state: 'offline', at: OFFLINE_SINCE }])
    const booted = new NcLivenessLedger({
      records: withNcFaults(world, { read: () => 'settings store unavailable' }).records,
      logger: makeSilentLogger(),
    })
    booted.observe(device(740, false), RESTART)
    await booted.load()
    await settle()
    expect(booted.stateOf('device:740')).toBe('offline')
    expect(ncTable(world, 'liveness')?.get('device:740')?.['updatedAt']).toBe(OFFLINE_SINCE)
  })

  it('M2: the settle SAYS what it did — kept, written, replayed', async () => {
    const world = worldWith([
      { id: 750, state: 'offline', at: OFFLINE_SINCE },
      { id: 751, state: 'online', at: OFFLINE_SINCE },
    ])
    const logger = makeSilentLogger()
    const info = vi.spyOn(logger, 'info')
    const booted = new NcLivenessLedger({ records: world.records, logger })
    booted.observe(device(750, false), RESTART)
    booted.observe(device(751, false), RESTART)
    await booted.load()
    expect(info).toHaveBeenCalledWith('boot window settled', {
      meta: { collection: 'notification-center:liveness', keptStored: 1, written: 1, replayed: 0 },
    })
  })

  it('L1: an observation between the load ANSWERING and the settle still belongs to the window', async () => {
    const world = worldWith([])
    const booted = new NcLivenessLedger({ records: world.records, logger: makeSilentLogger() })
    booted.observe(device(760, false), RESTART)
    const loading = booted.load()
    while (!booted.hasAnswered()) await Promise.resolve()
    // The gap: the store answered, the window is not settled yet.
    booted.observe(device(760, true), RESTART + 1_000)
    await loading
    await settle()
    expect(booted.stateOf('device:760')).toBe('online')
    const respawned = new NcLivenessLedger({ records: world.records, logger: makeSilentLogger() })
    await respawned.load()
    expect(respawned.stateOf('device:760')).toBe('online')
  })
})
