/**
 * A node sweeps only the cameras it analyses.
 *
 * Every node of the cluster runs this addon, and every node hydrates the SAME
 * `pipeline-analytics:stationary-objects` table in `load()`. So a sweep that
 * walks every hydrated device judges — and MUTATES — cameras this process has
 * never seen a frame of, with its own local view.
 *
 * Measured on the live hub 2026-09-14: the duplicate collapse for device 102
 * was logged by `MacMiniAgent.localdomain` AND by `agent-a` — the same
 * rows, the same entry ids, seven seconds apart.
 *
 * The ownership signal is the registry's observed clock (`noteFrame`): a node
 * receives inference frames for the cameras it analyses and for no others.
 * Same authority the summary sealer took for the same defect on the same table
 * one day earlier (`summary-sweep-scope.spec.ts`).
 */
import { makeAnalyticsRecordsNow, type FakeRecords } from '../../../__tests__/fake-records.js'
import { beforeEach, describe, expect, it } from 'vitest'

import { createNoopLogger } from '../../../../embedding-encoder/shared/noop-logger.js'
import { StationaryObjectRegistry } from '../stationary-registry.js'
import type { StationaryBbox, StationaryEntry } from '../stationary-types.js'

/** The real 102 box, to the decimal — four rows of it existed. */
const CAR: StationaryBbox = { x: 3476.4, y: 694.8, w: 360, h: 774 }
const T0 = 1_789_000_000_000
/** Long past any TTL: an unowned camera must not be aged out either. */
const LATE = T0 + 6 * 60 * 60_000
/** Well inside the TTL — a collapse, and nothing else, is under test here. */
const SOON = T0 + 120_000

function entry(over: Partial<StationaryEntry> = {}): StationaryEntry {
  return {
    id: over.id ?? 'e1',
    deviceId: over.deviceId ?? 102,
    className: 'vehicle',
    bbox: CAR,
    frameWidth: 3840,
    frameHeight: 2160,
    firstSeenAt: T0,
    becameStationaryAt: over.becameStationaryAt ?? T0,
    lastConfirmedAt: over.lastConfirmedAt ?? T0,
  }
}

/** Two rows on one spot, exactly as 102 holds them on disk. The per-call
 *  config bypasses the birth-time occupancy guard, which is what a row written
 *  before that guard shipped effectively did. */
async function seedDuplicatePair(reg: StationaryObjectRegistry, deviceId: number): Promise<void> {
  const wideOpen = { suppressIou: 2, wakeAssocIou: 2 }
  await reg.promote(entry({ id: `${deviceId}-a`, deviceId, becameStationaryAt: T0 }), wideOpen)
  await reg.promote(
    entry({ id: `${deviceId}-b`, deviceId, becameStationaryAt: T0 + 60_000 }),
    wideOpen,
  )
}

describe('the stationary sweep acts only on cameras this node analyses', () => {
  let world: FakeRecords
  let reg: StationaryObjectRegistry

  beforeEach(async () => {
    world = makeAnalyticsRecordsNow()
    reg = new StationaryObjectRegistry({ records: world.records, logger: createNoopLogger() })
  })

  it('leaves another node’s duplicates alone, however plainly duplicated they look', async () => {
    await seedDuplicatePair(reg, 102)
    // No `noteFrame`: this node has never framed 102. That is the whole of it.
    await reg.sweep(LATE)

    expect(reg.count(102)).toBe(2)
  })

  it('collapses its OWN camera’s duplicates on the same sweep', async () => {
    await seedDuplicatePair(reg, 102)
    reg.noteFrame(102, SOON)
    await reg.sweep(SOON)

    expect(reg.count(102)).toBe(1)
    // The oldest survives — "parked since" is the fact the operator reads.
    expect(reg.list(102)[0]?.id).toBe('102-a')
  })

  it('one sweep separates the two: its own camera collapses, the other node’s does not', async () => {
    await seedDuplicatePair(reg, 102)
    await seedDuplicatePair(reg, 3829)
    reg.noteFrame(102, SOON)
    await reg.sweep(SOON)

    expect(reg.count(102)).toBe(1)
    expect(reg.count(3829)).toBe(2)
  })

  it('does not retire an unanalysed camera’s entry on TTL either', async () => {
    await reg.promote(entry({ id: 'solo', lastConfirmedAt: T0 }))
    const retired = await reg.sweep(LATE)

    expect(retired).toEqual([])
    expect(reg.count(102)).toBe(1)
  })
})
