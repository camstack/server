/**
 * NcLivenessLedger — the durable "first observation seeds, only a flip
 * notifies" gate.
 *
 * ## The bug these pin
 *
 * 2026-08-13, the hub container was recreated. Every provider reconnected and
 * re-announced its devices; the notification centre held its last-known
 * liveness in RAM only, so every one of those announcements was the FIRST
 * observation of its subject and read as a fresh transition. The operator
 * received a "camera online" notification for every camera on the
 * installation.
 *
 * The cure is the occupancy cold-baseline cure (`occupancy-cold-seed.spec.ts`):
 * a change needs TWO observations, so the first one is written down and says
 * nothing.
 *
 * What is asserted here is the ledger in isolation — the three verdicts, the
 * durability across a fresh instance (a restart), which kinds it governs, and
 * the D49 direction of failure: a ledger that cannot read fails toward
 * DISCARD, never toward a flood.
 */
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords, withNcFaults } from './support/nc-test-deps.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  ledgeredLiveness,
  NcLivenessLedger,
  type NcLivenessObservation,
} from '../liveness-ledger.js'
import type { NcSystemEventSubject } from '../rule-engine.js'

const T0 = 1_700_000_000_000

/** A device liveness observation, as `ledgeredLiveness` would build it. */
function device(deviceId: number, online: boolean): NcLivenessObservation {
  return {
    subject: `device:${deviceId}`,
    kind: online ? 'device-online' : 'device-offline',
    state: online ? 'online' : 'offline',
    deviceId,
  }
}

/** A system-event subject, as the intake freezes one. */
function subject(overrides: Partial<NcSystemEventSubject>): NcSystemEventSubject {
  return {
    kind: 'device-online',
    subject: 'device:102',
    data: {},
    ...overrides,
  }
}

describe('NcLivenessLedger verdicts', () => {
  let world: InMemoryRecords
  let ledger: NcLivenessLedger

  beforeEach(async () => {
    world = makeNcRecords()
    ledger = new NcLivenessLedger({ records: world.records, logger: makeSilentLogger() })
  })

  it('SEEDS a cold subject — the first observation is recorded, never notified', () => {
    expect(ledger.observe(device(102, true), T0)).toBe('seeded')
    expect(ledger.stateOf('device:102')).toBe('online')
  })

  it('DISCARDS a repeat of the state it already holds', () => {
    ledger.observe(device(102, true), T0)
    expect(ledger.observe(device(102, true), T0 + 1_000)).toBe('no-flip')
    expect(ledger.observe(device(102, true), T0 + 2_000)).toBe('no-flip')
  })

  it('a no-flip does not move updatedAt — the row means "last CHANGED"', async () => {
    ledger.observe(device(102, true), T0)
    ledger.observe(device(102, true), T0 + 60_000)
    await Promise.resolve()
    expect(ledger.snapshot()).toEqual([
      {
        subject: 'device:102',
        state: 'online',
        kind: 'device-online',
        deviceId: 102,
        updatedAt: T0,
      },
    ])
  })

  it('REPORTS A FLIP — a genuine offline → online recovery is never suppressed', () => {
    expect(ledger.observe(device(102, false), T0)).toBe('seeded')
    expect(ledger.observe(device(102, true), T0 + 5_000)).toBe('flip')
    expect(ledger.stateOf('device:102')).toBe('online')
    // …and back down again.
    expect(ledger.observe(device(102, false), T0 + 9_000)).toBe('flip')
  })

  it('keys per subject — one camera flipping says nothing about another', () => {
    ledger.observe(device(101, true), T0)
    expect(ledger.observe(device(102, true), T0)).toBe('seeded')
    expect(ledger.observe(device(101, true), T0)).toBe('no-flip')
  })

  it('node subjects share the ledger and never collide with a device id', () => {
    const node: NcLivenessObservation = {
      subject: 'node:agent-1',
      kind: 'node-online',
      state: 'online',
    }
    expect(ledger.observe(node, T0)).toBe('seeded')
    expect(ledger.observe(node, T0 + 1)).toBe('no-flip')
    expect(ledger.observe({ ...node, kind: 'node-offline', state: 'offline' }, T0 + 2)).toBe('flip')
    expect(ledger.observe(device(1, true), T0)).toBe('seeded')
  })

  it('forgetWorkerNodeSubjects drops node:<node>/<child> leftovers and keeps real nodes (R2-L1)', async () => {
    await ledger.load()
    ledger.observe({ subject: 'node:agent-a', kind: 'node-offline', state: 'offline' }, T0)
    ledger.observe(
      { subject: 'node:hub/decoder-nodeav', kind: 'node-offline', state: 'offline' },
      T0,
    )
    ledger.observe(
      { subject: 'node:hub/provider-hikvision', kind: 'node-offline', state: 'offline' },
      T0,
    )
    await Promise.resolve()
    expect(await ledger.forgetWorkerNodeSubjects()).toBe(2)
    expect(ledger.stateOf('node:agent-a')).toBe('offline')
    expect(ledger.stateOf('node:hub/decoder-nodeav')).toBeUndefined()
    expect(ledger.stateOf('node:hub/provider-hikvision')).toBeUndefined()
  })
})

describe('NcLivenessLedger durability', () => {
  it('a state seeded before a restart is reloaded — the restart notifies NOTHING', async () => {
    const world = makeNcRecords()

    const before = new NcLivenessLedger({ records: world.records, logger: makeSilentLogger() })
    // A live process has loaded: an observation made BEFORE the load is
    // provisional and never persisted (D698, `liveness-boot-window.spec.ts`).
    await before.load()
    before.observe(device(102, true), T0)
    before.observe(device(101, true), T0)
    // The write is behind the verdict — let it land, as a live process would.
    await Promise.resolve()

    // A fresh instance over the SAME store IS the restart.
    const after = new NcLivenessLedger({ records: world.records, logger: makeSilentLogger() })
    expect(await after.load()).toBe(2)
    expect(after.observe(device(102, true), T0 + 60_000)).toBe('no-flip')
    expect(after.observe(device(101, true), T0 + 60_000)).toBe('no-flip')
    // …and a real change after the restart still gets through.
    expect(after.observe(device(102, false), T0 + 61_000)).toBe('flip')
  })

  it('THE HUB RECREATE: 15 cameras re-announcing online on a warm ledger yield ZERO flips', async () => {
    const world = makeNcRecords()
    const ids = Array.from({ length: 15 }, (_, i) => 600 + i)

    const before = new NcLivenessLedger({ records: world.records, logger: makeSilentLogger() })
    await before.load()
    for (const id of ids) before.observe(device(id, true), T0)
    await Promise.resolve()

    const after = new NcLivenessLedger({ records: world.records, logger: makeSilentLogger() })
    expect(await after.load()).toBe(15)
    const verdicts = ids.map((id) => after.observe(device(id, true), T0 + 120_000))
    expect(verdicts.filter((v) => v === 'flip')).toEqual([])
    expect(new Set(verdicts)).toEqual(new Set(['no-flip']))
  })

  it('a load that FAILS keeps the memory it has — the mirror is never wiped on an error', async () => {
    const world = makeNcRecords()
    const ledger = new NcLivenessLedger({ records: world.records, logger: makeSilentLogger() })
    ledger.observe(device(102, true), T0)

    const broken = new NcLivenessLedger({
      records: withNcFaults(world, { read: () => 'settings store unavailable' }).records,
      logger: makeSilentLogger(),
    })
    broken.observe(device(102, true), T0)
    expect(await broken.load()).toBe(1)
    expect(broken.stateOf('device:102')).toBe('online')
  })

  it('D49: an EMPTY ledger seeds rather than flips — a failed read costs a silence, not a flood', async () => {
    const world = makeNcRecords()
    const cold = new NcLivenessLedger({ records: world.records, logger: makeSilentLogger() })
    expect(await cold.load()).toBe(0)
    expect(cold.observe(device(102, true), T0)).toBe('seeded')
  })

  it('a persist that fails never changes the verdict the event already got', async () => {
    const ledger = new NcLivenessLedger({
      records: withNcFaults(makeNcRecords(), { write: () => 'disk full' }).records,
      logger: makeSilentLogger(),
    })
    expect(ledger.observe(device(102, true), T0)).toBe('seeded')
    await Promise.resolve()
    expect(ledger.observe(device(102, true), T0 + 1)).toBe('no-flip')
  })

  it('a stored row with an unknown state is skipped — it can never become a phantom flip', async () => {
    const world = makeNcRecords()
    world.seed('liveness', {
      id: 'device:102',
      data: { state: 'perhaps', kind: 'device-online', deviceId: 102, updatedAt: T0 },
    })
    const ledger = new NcLivenessLedger({ records: world.records, logger: makeSilentLogger() })
    expect(await ledger.load()).toBe(0)
    expect(ledger.observe(device(102, true), T0)).toBe('seeded')
  })
})

describe('ledgeredLiveness — which kinds the ledger governs', () => {
  it('governs device and node liveness, in both directions', () => {
    expect(ledgeredLiveness(subject({ kind: 'device-online', deviceId: 102 }))).toEqual({
      subject: 'device:102',
      kind: 'device-online',
      state: 'online',
      deviceId: 102,
    })
    expect(ledgeredLiveness(subject({ kind: 'device-offline', deviceId: 102 }))?.state).toBe(
      'offline',
    )
    expect(ledgeredLiveness(subject({ kind: 'node-online', subject: 'node:agent-1' }))).toEqual({
      subject: 'node:agent-1',
      kind: 'node-online',
      state: 'online',
    })
    expect(
      ledgeredLiveness(subject({ kind: 'node-offline', subject: 'node:agent-1' }))?.state,
    ).toBe('offline')
  })

  it('governs the legacy camera-* tail, so it can never bypass the gate', () => {
    expect(ledgeredLiveness(subject({ kind: 'camera-online' }))?.state).toBe('online')
    expect(ledgeredLiveness(subject({ kind: 'camera-offline' }))?.state).toBe('offline')
  })

  it('does NOT govern the operator switch — a hand-pressed disable must never be seeded away', () => {
    // D62: `device.disabled` / `device.enabled` are emitted only on a
    // transition of the flag, never at boot. Ledgering them would swallow the
    // first disable after a fresh ledger, which is a real action nobody was
    // told about — and there is no boot flood to trade it against.
    expect(ledgeredLiveness(subject({ kind: 'device-disabled' }))).toBeNull()
    expect(ledgeredLiveness(subject({ kind: 'device-enabled' }))).toBeNull()
    expect(ledgeredLiveness(subject({ kind: 'camera-disabled' }))).toBeNull()
    expect(ledgeredLiveness(subject({ kind: 'camera-enabled' }))).toBeNull()
  })

  it('does NOT govern stream health — it is already reason-gated at the intake', () => {
    expect(ledgeredLiveness(subject({ kind: 'stream-online', subject: 'stream:s1' }))).toBeNull()
    expect(ledgeredLiveness(subject({ kind: 'stream-offline', subject: 'stream:s1' }))).toBeNull()
  })

  it('does NOT govern updates or the alarm panel', () => {
    expect(ledgeredLiveness(subject({ kind: 'addon-update-available' }))).toBeNull()
    expect(ledgeredLiveness(subject({ kind: 'server-update-available' }))).toBeNull()
    expect(ledgeredLiveness(subject({ kind: 'alarm-armed' }))).toBeNull()
    expect(ledgeredLiveness(subject({ kind: 'alarm-triggered' }))).toBeNull()
  })
})
