/**
 * "As of now, would this occupancy rule fire?" — the rule tester's occupancy answer.
 *
 * ## What was wrong
 *
 * `testRule` builds candidate subjects from PERSISTED records: object events,
 * closed tracks, package rows. An occupancy edge persists no record of its own,
 * so a `device-event` rule carrying an `occupancy` condition dry-ran to an EMPTY
 * result list — indistinguishable, on screen, from "this rule matches nothing".
 * The one rule kind whose truth is fully available RIGHT NOW (the live
 * ZoneAnalytics snapshot IS the state the condition is about) was the one kind
 * the tester could say nothing about.
 *
 * ## What it answers, and what it must never claim
 *
 * The probe reads the CURRENT snapshot, reduces it through the SAME
 * `resolveOccupancyScope` the live watcher uses, and runs the synthesized
 * subject through the SAME `evaluateRule`. So a dry-run can never disagree with
 * the edge that snapshot would produce.
 *
 * It is a LEVEL answer, and the label says so: a live fire also needs the
 * transition and the sustain window (and then the cooldown). Fail-closed is
 * reported, never hidden — no snapshot at all, or a zoneId the snapshot does
 * not contain, is exactly why a rule "never fires", and it is now a visible row
 * instead of an empty list.
 */
import type { InMemoryRecords } from '@camstack/types'
import type { CameraOccupancySnapshot, NcOccupancyCondition, NcRuleInput } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcTargetRef } from '../dispatcher.js'
import { completeLoggerStub, ncPruneWindowsPort, makeNcRecords } from './support/nc-test-deps.js'
import { NotificationCenter } from '../index.js'
import { occupancyProbeLabel, probeOccupancyNow } from '../occupancy-dry-run.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const NOW = 1_786_185_854_852
const CAMERA = 101
const ZONE = 'zone-cortile'

function condition(overrides: Partial<NcOccupancyCondition> = {}): NcOccupancyCondition {
  return {
    zoneId: ZONE,
    className: 'person',
    op: 'became-occupied',
    count: 1,
    sustainSeconds: 5,
    ...overrides,
  }
}

function snapshot(persons: number): CameraOccupancySnapshot {
  return {
    ts: NOW - 400,
    frameWidth: 1920,
    frameHeight: 1080,
    zones: [
      {
        zoneId: ZONE,
        zoneName: 'Cortile',
        totalObjects: persons,
        byClass: persons > 0 ? { person: persons } : {},
        trackIds: Array.from({ length: persons }, (_, i) => `trk-${String(i)}`),
      },
    ],
    frame: { totalObjects: persons, byClass: persons > 0 ? { person: persons } : {} },
    unzoned: { totalObjects: 0, byClass: {} },
  }
}

// ── the pure probe ──────────────────────────────────────────────────

describe('probeOccupancyNow', () => {
  it('synthesizes an occupancy subject from the live counts', () => {
    const probe = probeOccupancyNow({
      occupancy: condition(),
      deviceId: CAMERA,
      snapshot: snapshot(2),
      now: NOW,
    })
    expect(probe.kind).toBe('probed')
    if (probe.kind !== 'probed') return
    expect(probe.count).toBe(2)
    expect(probe.zoneName).toBe('Cortile')
    expect(probe.subject.kind).toBe('occupancy-event')
    expect(probe.subject.deviceId).toBe(CAMERA)
    // The scope + the crossing predicate, as the engine matches them.
    expect(probe.subject.occupancy).toMatchObject({
      zoneId: ZONE,
      zoneName: 'Cortile',
      className: 'person',
      count: 2,
      threshold: 1,
      occupied: true,
    })
    // A probe is never mistakable for a committed edge.
    expect(probe.subject.recordId.startsWith('dryrun:')).toBe(true)
  })

  it('reads a `<=` rule against the key it actually watches (C+1)', () => {
    const probe = probeOccupancyNow({
      occupancy: condition({ op: '<=', count: 2 }),
      deviceId: CAMERA,
      snapshot: snapshot(2),
      now: NOW,
    })
    if (probe.kind !== 'probed') throw new Error('expected a probe')
    // `<=2` keys on threshold 3: two people is BELOW it, so the un-occupied
    // side the rule fires on is satisfied right now.
    expect(probe.subject.occupancy?.threshold).toBe(3)
    expect(probe.subject.occupancy?.occupied).toBe(false)
  })

  it('is fail-closed and SAYS which: no snapshot at all', () => {
    const probe = probeOccupancyNow({
      occupancy: condition(),
      deviceId: CAMERA,
      snapshot: null,
      now: NOW,
    })
    expect(probe).toEqual({ kind: 'unavailable', reason: 'no-snapshot' })
  })

  it('is fail-closed and SAYS which: the zone is not in the snapshot', () => {
    const probe = probeOccupancyNow({
      occupancy: condition({ zoneId: 'zone-deleted' }),
      deviceId: CAMERA,
      snapshot: snapshot(2),
      now: NOW,
    })
    expect(probe).toEqual({ kind: 'unavailable', reason: 'zone-absent' })
  })
})

describe('occupancyProbeLabel', () => {
  it('reports the evaluated counts, the level and what a live fire still needs', () => {
    const probe = probeOccupancyNow({
      occupancy: condition(),
      deviceId: CAMERA,
      snapshot: snapshot(2),
      now: NOW,
    })
    const label = occupancyProbeLabel(condition(), probe, 60)
    expect(label).toContain('Cortile')
    expect(label).toContain('2/1')
    expect(label).toContain('person')
    expect(label).toContain('occupied now')
    // The honest caveat: the tester answers a LEVEL question, the engine fires
    // on an EDGE — and then only outside the cooldown.
    expect(label).toContain('5 s')
    expect(label).toContain('cooldown 60 s')
  })

  /**
   * The third way an occupancy rule "never fires", and the one the tester used
   * to present as a perfectly healthy 0: a class the snapshot cannot key on.
   * `byClass` holds MACRO classes only, so `car` reads a key that does not
   * exist — 0 on every frame, forever. Two live rules were authored that way
   * (device 102, 2026-08-12) and the dry-run showed "0/1 car · not occupied
   * now", which is exactly what a genuinely empty parking space looks like.
   */
  it('flags a non-macro class — the counter is structurally always 0', () => {
    const occ = condition({ className: 'car' })
    const probe = probeOccupancyNow({
      occupancy: occ,
      deviceId: CAMERA,
      snapshot: snapshot(2),
      now: NOW,
    })
    const label = occupancyProbeLabel(occ, probe, 0)
    expect(label).toContain('car')
    expect(label).toMatch(/non-macro|sub-type/i)
    // The counts stay in the line: the operator still sees what was read.
    expect(label).toContain('0/1')
  })

  it('says nothing extra for a macro class', () => {
    const probe = probeOccupancyNow({
      occupancy: condition(),
      deviceId: CAMERA,
      snapshot: snapshot(2),
      now: NOW,
    })
    expect(occupancyProbeLabel(condition(), probe, 0)).not.toMatch(/non-macro|sub-type/i)
  })

  it('flags the class even when the probe could not be taken at all', () => {
    const occ = condition({ className: 'car' })
    const label = occupancyProbeLabel(occ, { kind: 'unavailable', reason: 'no-snapshot' }, 0)
    expect(label).toMatch(/non-macro|sub-type/i)
  })

  it('names the fail-closed reason instead of a count', () => {
    const label = occupancyProbeLabel(
      condition(),
      { kind: 'unavailable', reason: 'no-snapshot' },
      0,
    )
    expect(label).toContain('no ZoneAnalytics snapshot')
    expect(label).not.toContain('cooldown')
  })
})

// ── the tester surface ──────────────────────────────────────────────

interface Harness {
  readonly center: NotificationCenter
  readonly store: FakeSettingsStore
  readonly world: InMemoryRecords
  /** Every device-id set the dry-run asked snapshots for. */
  readonly snapshotReads: (readonly number[] | undefined)[]
}

function occupancyRule(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Cortile occupato',
    delivery: 'device-event',
    targets: [{ targetId: 'zentik' }],
    conditions: { devices: [CAMERA], occupancy: condition() },
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    ...overrides,
  })
}

function makeHarness(snapshots: ReadonlyMap<number, CameraOccupancySnapshot>): Harness {
  const store = makeFakeSettingsStore()
  const world = makeNcRecords()
  const snapshotReads: (readonly number[] | undefined)[] = []
  const noop = (): void => {}
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: (): unknown => logger }
  const targets: NcTargetRef[] = [
    { id: 'zentik', addonId: 'notifiers', name: 'Zentik', kind: 'zentik', enabled: true },
  ]
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: completeLoggerStub(logger),
    pruneWindows: ncPruneWindowsPort(),
    dispatcher: {
      listTargets: async () => targets,
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      renderEventMedia: async () => ({ gif: null, mp4: null }),
      getDeviceName: async () => 'Cortile',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    readOccupancySnapshots: async (deviceIds) => {
      snapshotReads.push(deviceIds)
      if (deviceIds === undefined) return snapshots
      const out = new Map<number, CameraOccupancySnapshot>()
      for (const id of deviceIds) {
        const snap = snapshots.get(id)
        if (snap !== undefined) out.set(id, snap)
      }
      return out
    },
    now: () => NOW,
    drainIntervalMs: 5,
    ruleReloadIntervalMs: 3_600_000,
  })
  return { center, store, world, snapshotReads }
}

async function boot(snapshots: ReadonlyMap<number, CameraOccupancySnapshot>): Promise<Harness> {
  const h = makeHarness(snapshots)
  await h.center.start({ evaluation: true })
  return h
}

describe('testRule answers an occupancy rule from the live snapshot', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('would fire: the zone currently holds enough of the class', async () => {
    h = await boot(new Map([[CAMERA, snapshot(2)]]))

    const { results } = await h.center
      .buildProvider()
      .testRule({ rule: occupancyRule(), lookbackMinutes: 60 })

    expect(results).toHaveLength(1)
    const row = results[0]
    expect(row?.wouldFire).toBe(true)
    expect(row?.deviceId).toBe(CAMERA)
    expect(row?.recordKind).toBe('device-event')
    expect(row?.className).toBe('person')
    expect(row?.label).toContain('2/1')
    // The reading is stamped with the FRAME it came from, not with "now" — an
    // operator has to be able to see a stale camera.
    expect(row?.timestamp).toBe(NOW - 400)
    // Only the rule's own devices were read.
    expect(h.snapshotReads).toEqual([[CAMERA]])
  })

  it('would NOT fire: the zone is empty, and the row says the count', async () => {
    h = await boot(new Map([[CAMERA, snapshot(0)]]))

    const { results } = await h.center
      .buildProvider()
      .testRule({ rule: occupancyRule(), lookbackMinutes: 60 })

    expect(results[0]?.wouldFire).toBe(false)
    expect(results[0]?.failedCondition).toBe('occupancy')
    expect(results[0]?.label).toContain('0/1')
  })

  it('a camera with no snapshot is a REPORTED row, not an empty list', async () => {
    h = await boot(new Map())

    const { results } = await h.center
      .buildProvider()
      .testRule({ rule: occupancyRule(), lookbackMinutes: 60 })

    expect(results).toHaveLength(1)
    expect(results[0]?.wouldFire).toBe(false)
    expect(results[0]?.failedCondition).toBe('occupancy')
    expect(results[0]?.label).toContain('no ZoneAnalytics snapshot')
  })

  it('an unscoped rule probes every camera that has a snapshot', async () => {
    h = await boot(
      new Map([
        [CAMERA, snapshot(2)],
        [102, snapshot(0)],
      ]),
    )

    const { results } = await h.center.buildProvider().testRule({
      rule: occupancyRule({ conditions: { occupancy: condition() } }),
      lookbackMinutes: 60,
    })

    expect(h.snapshotReads).toEqual([undefined])
    expect(results.map((r) => `${String(r.deviceId)}:${String(r.wouldFire)}`).sort()).toEqual([
      '101:true',
      '102:false',
    ])
  })

  it('a device-event rule WITHOUT occupancy is untouched (still no candidates)', async () => {
    h = await boot(new Map([[CAMERA, snapshot(2)]]))

    const { results } = await h.center.buildProvider().testRule({
      rule: occupancyRule({ conditions: { devices: [CAMERA], sensorKinds: ['doorbell'] } }),
      lookbackMinutes: 60,
    })

    expect(results).toEqual([])
    expect(h.snapshotReads).toEqual([])
  })
})
