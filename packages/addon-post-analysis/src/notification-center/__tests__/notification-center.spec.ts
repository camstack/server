/**
 * NotificationCenter integration tests (fake store + fake clock) — the
 * persist hooks (immediate + track-end), durable per-track dedup, the
 * restart-proof cooldown, the boot watermark reconcile and the cap
 * provider surface (caller-stamped CRUD, target validation, testRule).
 */

import type { InMemoryRecords } from '@camstack/types'
import { ncRecordKinds } from '../record-kinds.js'
import { ncPruneWindowsPort, makeNcRecords, ncTable } from './support/nc-test-deps.js'
import type {
  CameraOccupancySnapshot,
  MediaFile,
  NcRuleInput,
  ObjectEvent,
  Track,
} from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import type { OccupancyEdge } from '../occupancy-watcher.js'
import { type NcOutboxPayload } from '../outbox.js'
import { NcRuleStore } from '../rule-store.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeTestAudioEvent, makeTestObjectEvent } from '../../__tests__/support/events.js'
import type { NcUserGrant } from '../index.js'

/** Stable numeric event ids for assertions on `recordId` (`String(ev.id)`). */
const TEST_EV = {
  a: 80_001,
  b: 80_002,
  art: 80_003,
  live: 80_004,
  match: 80_005,
  miss: 80_006,
  zone: 80_007,
  e1: 80_008,
  e2: 80_009,
  missed1: 80_010,
  missed2: 80_011,
  audX: 80_012,
  pkgDelivered: 81_001,
  pkgPickedUp: 81_002,
} as const

const makeEvent = makeTestObjectEvent
const makeAudioEvent = makeTestAudioEvent

function makeRuleInput(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'person rule',
    delivery: 'immediate',
    targets: [{ targetId: 'tgt-1' }],
    conditions: { classes: ['person'] },
    ...overrides,
  })
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    trackId: 'trk-9',
    deviceId: 104,
    className: 'person',
    firstSeen: 90_000,
    lastSeen: 100_000,
    positions: [],
    snapshots: [],
    zonesVisited: ['gate'],
    totalDistance: 0.2,
    state: 'left',
    active: false,
    ...overrides,
  }
}

interface Harness {
  readonly center: NotificationCenter
  readonly store: FakeSettingsStore
  readonly world: InMemoryRecords
  readonly sends: NcSendInput[]
  readonly events: ObjectEvent[]
  readonly tracks: Track[]
  setNow(ts: number): void
}

const CALLER = { userId: 'admin-42', isAdmin: true }

function makeHarness(): Harness {
  const store = makeFakeSettingsStore()
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  const events: ObjectEvent[] = []
  const tracks: Track[] = []
  let now = 100_000
  const targets: NcTargetRef[] = [
    { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
    { id: 'tgt-2', addonId: 'notifiers', name: 'tv', kind: 'webhook', enabled: true },
    // A PERSONAL target owned by a viewer user — the rule→user fan-out pool.
    {
      id: 'tgt-user-1',
      addonId: 'notifiers',
      name: 'bob-phone',
      kind: 'ntfy',
      enabled: true,
      ownerUserId: 'user-bob',
    },
  ]
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: ncPruneWindowsPort(),
    listUsers: async (): Promise<readonly NcUserGrant[]> => [
      { id: 'user-bob', isAdmin: false, allowedDevices: { 'provider-x': ['stable-104'] } },
      { id: 'user-ann', isAdmin: false, allowedDevices: {} },
    ],
    getDeviceRoute: async (deviceId) =>
      deviceId === 104 ? { stableId: 'stable-104', addonId: 'provider-x' } : null,
    dispatcher: {
      listTargets: async () => targets,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Driveway',
    },
    listObjectEventsSince: async (since) => events.filter((e) => e.timestamp >= since),
    listRecentTracks: async (since) => tracks.filter((t) => t.lastSeen >= since),
    now: () => now,
    // Timers are irrelevant in tests (drain driven implicitly / asserted on
    // rows); keep them long and always stop() in afterEach.
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  return {
    center,
    store,
    world,
    sends,
    events,
    tracks,
    setNow: (ts) => {
      now = ts
    },
  }
}

function outboxIds(world: InMemoryRecords): string[] {
  return [...(ncTable(world, 'outbox')?.keys() ?? [])]
}

function outboxPayload(world: InMemoryRecords, id: string): NcOutboxPayload {
  const row = ncTable(world, 'outbox')?.get(id)
  const payload = row?.['payload']
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`no outbox payload for ${id}`)
  }
  // Documented type boundary — the payload JSON round-trips as `unknown`
  // through the fake store, same narrowing pattern as `rowToEntry`.
  return payload as NcOutboxPayload
}

async function waitForOutbox(world: InMemoryRecords, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(outboxIds(world)).toHaveLength(count)
  })
}

describe('NotificationCenter', () => {
  let h: Harness

  afterEach(async () => {
    await h.center.stop()
  })

  describe('immediate hook (object-event persist moment)', () => {
    it('a matching event enqueues one outbox row per rule target', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      const provider = h.center.buildProvider()
      await provider.createRule({
        rule: makeRuleInput({ targets: [{ targetId: 'tgt-1' }, { targetId: 'tgt-2' }] }),
        caller: CALLER,
      })
      h.center.onObjectEventPersisted(makeEvent())
      await waitForOutbox(h.world, 2)
      const ids = outboxIds(h.world)
      expect(ids.some((id) => id.endsWith(':tgt-1'))).toBe(true)
      expect(ids.some((id) => id.endsWith(':tgt-2'))).toBe(true)
    })

    it('a USERS-ONLY rule (no direct targets) is accepted and fans out', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({ targets: [], targetUsers: ['user-bob'] }),
        caller: CALLER,
      })
      h.center.onObjectEventPersisted(makeEvent())
      await waitForOutbox(h.world, 1)
      expect(outboxIds(h.world)[0]!.endsWith(':tgt-user-1')).toBe(true)
    })

    it('a rule with NO targets and NO users is rejected at save', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await expect(
        h.center.buildProvider().createRule({
          rule: makeRuleInput({ targets: [] }),
          caller: CALLER,
        }),
      ).rejects.toThrow(/at least one delivery target or user/)
    })

    it('a rule addressing a USER fans out to the targets that user owns', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({ targets: [{ targetId: 'tgt-1' }], targetUsers: ['user-bob'] }),
        caller: CALLER,
      })
      h.center.onObjectEventPersisted(makeEvent())
      await waitForOutbox(h.world, 2)
      const ids = outboxIds(h.world)
      expect(ids.some((id) => id.endsWith(':tgt-1'))).toBe(true)
      expect(ids.some((id) => id.endsWith(':tgt-user-1'))).toBe(true)
    })

    it('a user WITHOUT an allowedDevices grant for the camera gets nothing', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({ targets: [{ targetId: 'tgt-1' }], targetUsers: ['user-ann'] }),
        caller: CALLER,
      })
      h.center.onObjectEventPersisted(makeEvent())
      await waitForOutbox(h.world, 1)
      const ids = outboxIds(h.world)
      expect(ids).toHaveLength(1)
      expect(ids[0]!.endsWith(':tgt-1')).toBe(true)
    })

    it('freezes the matched-condition summary on the outbox payload', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({
          conditions: { classes: ['person'], identities: ['john'] },
          media: { attach: 'best-matching' },
        }),
        caller: CALLER,
      })
      h.center.onObjectEventPersisted(makeEvent({ label: 'John' }))
      await waitForOutbox(h.world, 1)
      const payload = outboxPayload(h.world, outboxIds(h.world)[0]!)
      // D897: a pre-D897 `best-matching` rule renders the subject crop.
      expect(payload.mediaImage).toBe('crop')
      expect(payload.matchedOn).toEqual(['classes', 'identities'])
    })

    it('omits the matchedOn summary when the rule has no conditions', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({ conditions: {} }),
        caller: CALLER,
      })
      h.center.onObjectEventPersisted(makeEvent())
      await waitForOutbox(h.world, 1)
      expect(outboxPayload(h.world, outboxIds(h.world)[0]!).matchedOn).toBeUndefined()
    })

    it('non-matching events enqueue nothing', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })
      h.center.onObjectEventPersisted(makeEvent({ className: 'vehicle' }))
      // Give the async evaluation a tick, then assert emptiness.
      await new Promise((r) => setImmediate(r))
      expect(outboxIds(h.world)).toHaveLength(0)
    })

    it('maxPerTrack=1: a second event of the SAME track is a dedup no-op', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center
        .buildProvider()
        .createRule({ rule: makeRuleInput({ throttle: { cooldownSec: 0 } }), caller: CALLER })
      h.center.onObjectEventPersisted(makeEvent({ id: TEST_EV.a, trackId: 'trk-1' }))
      await waitForOutbox(h.world, 1)
      h.center.onObjectEventPersisted(makeEvent({ id: TEST_EV.b, trackId: 'trk-1' }))
      await new Promise((r) => setImmediate(r))
      expect(outboxIds(h.world)).toHaveLength(1)
    })

    it('cooldown (rule-device) throttles a second track on the same camera, not another camera', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({ throttle: { cooldownSec: 60, scope: 'rule-device' } }),
        caller: CALLER,
      })
      h.center.onObjectEventPersisted(makeEvent({ trackId: 'trk-1', deviceId: 104 }))
      await waitForOutbox(h.world, 1)
      // Same device, new track, still inside the 60s window → throttled.
      h.setNow(130_000)
      h.center.onObjectEventPersisted(makeEvent({ trackId: 'trk-2', deviceId: 104 }))
      await new Promise((r) => setImmediate(r))
      expect(outboxIds(h.world)).toHaveLength(1)
      // OTHER device inside the window → its own cooldown key, fires.
      h.center.onObjectEventPersisted(makeEvent({ trackId: 'trk-3', deviceId: 102 }))
      await waitForOutbox(h.world, 2)
      // Same device after the window → fires again.
      h.setNow(161_000)
      h.center.onObjectEventPersisted(makeEvent({ trackId: 'trk-4', deviceId: 104 }))
      await waitForOutbox(h.world, 3)
    })

    it('hooks are inert without evaluation mode (non-post-processing node)', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })
      h.center.onObjectEventPersisted(makeEvent())
      await new Promise((r) => setImmediate(r))
      expect(outboxIds(h.world)).toHaveLength(0)
    })
  })

  describe('audio hook (classified-audio persist moment)', () => {
    it('an immediate rule opting in to the matching audio class enqueues (dedup by audio id)', async () => {
      h = makeHarness()
      // A LEGACY audio-class rule: refused on save since D690, still loaded and
      // evaluated when stored before it — so it is written to the store first.
      const rule = await new NcRuleStore({
        kind: h.world.records.kind(ncRecordKinds.rules),
        logger: makeSilentLogger(),
      }).create(makeRuleInput({ conditions: { classes: ['audio-dog'] } }), CALLER.userId)
      await h.center.start({ evaluation: true })
      h.center.onAudioEventPersisted(makeAudioEvent({ id: TEST_EV.audX }))
      await waitForOutbox(h.world, 1)
      // No trackId → a record ref. An audio id is a reusable ROWID (D474), so
      // the ref carries the record's generation, `<id>@<deviceId>:<timestamp>`
      // (D694) — never the id alone.
      expect(outboxIds(h.world)[0]).toBe(`${rule.id}:${TEST_EV.audX}@104:100000:tgt-1`)
      const payload = outboxPayload(h.world, outboxIds(h.world)[0]!)
      expect(payload.subject.className).toBe('audio-dog')
      // Audio carries no crop owner → no eventId/trackId on the payload subject.
      expect(payload.subject.eventId).toBeUndefined()
      expect(payload.subject.trackId).toBeUndefined()
    })

    it('a rule with only VIDEO classes never fires on audio (safety gate)', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })
      h.center.onAudioEventPersisted(makeAudioEvent())
      await new Promise((r) => setImmediate(r))
      expect(outboxIds(h.world)).toHaveLength(0)
    })

    it('the audio hook is inert without evaluation mode', async () => {
      h = makeHarness()
      await new NcRuleStore({
        kind: h.world.records.kind(ncRecordKinds.rules),
        logger: makeSilentLogger(),
      }).create(makeRuleInput({ conditions: { classes: ['audio-dog'] } }), CALLER.userId)
      await h.center.start({ evaluation: false })
      h.center.onAudioEventPersisted(makeAudioEvent())
      await new Promise((r) => setImmediate(r))
      expect(outboxIds(h.world)).toHaveLength(0)
    })
  })

  describe('enqueue-time per-target opt-out (rule.disabledTargetIds)', () => {
    it('an opted-out target produces NO outbox row; the rule’s other targets still enqueue', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      const { rule } = await h.center.buildProvider().createRule({
        rule: makeRuleInput({ targets: [{ targetId: 'tgt-1' }, { targetId: 'tgt-2' }] }),
        caller: CALLER,
      })
      // The user opts tgt-1 out of THIS rule — history must carry no row for it
      // (a `sent`-marked row for an undelivered target is a false delivery claim).
      await h.center.ruleStore.setRuleTargetEnabled(rule.id, 'tgt-1', false)
      h.center.onObjectEventPersisted(makeEvent())
      await waitForOutbox(h.world, 1)
      const ids = outboxIds(h.world)
      expect(ids.some((id) => id.endsWith(':tgt-2'))).toBe(true)
      expect(ids.some((id) => id.endsWith(':tgt-1'))).toBe(false)
    })

    it('an all-opted-out fire inserts 0 rows and does NOT consume the cooldown', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      const { rule } = await h.center.buildProvider().createRule({
        rule: makeRuleInput({ throttle: { cooldownSec: 60, scope: 'rule-device' } }),
        caller: CALLER,
      })
      // Opt the sole target out → the fire enqueues nothing.
      await h.center.ruleStore.setRuleTargetEnabled(rule.id, 'tgt-1', false)
      h.center.onObjectEventPersisted(makeEvent({ trackId: 'trk-1', deviceId: 104 }))
      await new Promise((r) => setImmediate(r))
      expect(outboxIds(h.world)).toHaveLength(0)
      // Re-enable, then a NEW track on the SAME device INSIDE the 60s window
      // must still fire: the empty fire above never set lastFiredAt, so the
      // cooldown was not consumed (the `inserted > 0` gate did the right thing).
      await h.center.ruleStore.setRuleTargetEnabled(rule.id, 'tgt-1', true)
      h.setNow(130_000)
      h.center.onObjectEventPersisted(makeEvent({ trackId: 'trk-2', deviceId: 104 }))
      await waitForOutbox(h.world, 1)
      expect(outboxIds(h.world).some((id) => id.endsWith(':tgt-1'))).toBe(true)
    })
  })

  describe('track-end hook', () => {
    it('a matching closed track enqueues via the track-end rule set', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({
          delivery: 'track-end',
          conditions: { classes: ['person'], minConfidence: 0.5 },
        }),
        caller: CALLER,
      })
      const media: MediaFile[] = []
      h.center.onTrackClosed(makeTrack(), media, { bestConfidence: 0.8 })
      await waitForOutbox(h.world, 1)
      expect(outboxIds(h.world)[0]).toBe(`${outboxIds(h.world)[0]!.split(':')[0]}:trk-9:tgt-1`)
    })

    it('freezes only rule-matched zones into the notification template subject', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({
          delivery: 'track-end',
          conditions: { classes: ['person'], zones: { ids: ['gate'], match: 'any' } },
        }),
        caller: CALLER,
      })

      h.center.onTrackClosed(makeTrack({ zonesVisited: ['gate', 'lawn'] }), [], {})
      await waitForOutbox(h.world, 1)

      expect(outboxPayload(h.world, outboxIds(h.world)[0]!).subject.zones).toEqual(['gate'])
    })

    it('immediate rules never fire on track close (delivery gate)', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })
      h.center.onTrackClosed(makeTrack(), [], {})
      await new Promise((r) => setImmediate(r))
      expect(outboxIds(h.world)).toHaveLength(0)
    })
  })

  describe('device-event hook (sensor persist moment)', () => {
    it('a matching sensor event enqueues via the device-event rule set', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({
          delivery: 'device-event',
          conditions: { sensorKinds: ['doorbell'] },
        }),
        caller: CALLER,
      })
      h.center.onSensorEventPersisted({
        id: 'se-77',
        deviceId: 104,
        sourceDeviceId: 42,
        kind: 'doorbell',
        value: null,
        timestamp: 100_000,
      })
      await waitForOutbox(h.world, 1)
      // dedup ref is the sensor-event id (no track scope).
      expect(outboxIds(h.world)[0]).toBe(`${outboxIds(h.world)[0]!.split(':')[0]}:se-77:tgt-1`)
    })

    it('a non-matching sensor kind does not fire', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({ delivery: 'device-event', conditions: { sensorKinds: ['contact'] } }),
        caller: CALLER,
      })
      h.center.onSensorEventPersisted({
        id: 'se-1',
        deviceId: 104,
        sourceDeviceId: 42,
        kind: 'doorbell',
        value: null,
        timestamp: 100_000,
      })
      await new Promise((r) => setImmediate(r))
      expect(outboxIds(h.world)).toHaveLength(0)
    })
  })

  describe('package-event hook (package persist moment)', () => {
    const pkg = (id: number, state: 'idle' | 'left'): ObjectEvent =>
      makeEvent({
        id,
        trackId: 'trk-pkg',
        className: 'package',
        state,
        zones: ['porch'],
        confidence: 1,
      })

    it('a delivery enqueues via the package-event rule set', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({
          delivery: 'package-event',
          conditions: { packagePhase: 'delivered' },
        }),
        caller: CALLER,
      })
      h.center.onPackageEventPersisted(pkg(TEST_EV.pkgDelivered, 'idle'), 'delivered')
      await waitForOutbox(h.world, 1)
    })

    it('delivery + pick-up on the SAME source track are distinct rows (not deduped)', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({
          delivery: 'package-event',
          conditions: { packagePhase: 'both' },
          throttle: { cooldownSec: 0, scope: 'rule-device' },
        }),
        caller: CALLER,
      })
      h.center.onPackageEventPersisted(pkg(TEST_EV.pkgDelivered, 'idle'), 'delivered')
      h.center.onPackageEventPersisted(pkg(TEST_EV.pkgPickedUp, 'left'), 'picked-up')
      // Two distinct records → two outbox rows despite the shared trackId.
      await waitForOutbox(h.world, 2)
    })
  })

  describe('occupancy hook (ZoneAnalytics count edge)', () => {
    function makeOccupancyEdge(overrides: Partial<OccupancyEdge> = {}): OccupancyEdge {
      return {
        deviceId: 104,
        count: 2,
        previousCount: 0,
        occupied: true,
        threshold: 2,
        timestamp: 100_000,
        ...overrides,
      }
    }

    function occSnapshot(frameTotal: number): CameraOccupancySnapshot {
      return {
        ts: 100_000,
        frameWidth: 1920,
        frameHeight: 1080,
        zones: [],
        frame: { totalObjects: frameTotal, byClass: {} },
        unzoned: { totalObjects: 0, byClass: {} },
      }
    }

    it('(d) an occupancy edge enqueues under `device-event` — history recordKind is device-event (no downgrade)', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      const provider = h.center.buildProvider()
      await provider.createRule({
        rule: makeRuleInput({
          delivery: 'device-event',
          conditions: { occupancy: { op: 'became-occupied', count: 2 } },
        }),
        caller: CALLER,
      })
      h.center.onOccupancyEdge(makeOccupancyEdge())
      await waitForOutbox(h.world, 1)
      const payload = outboxPayload(h.world, outboxIds(h.world)[0]!)
      expect(payload.delivery).toBe('device-event')
      expect(payload.subject.className).toBe('occupancy')
      const { entries } = await provider.getHistory({ filter: { limit: 10 } })
      expect(entries).toHaveLength(1)
      expect(entries[0]!.recordKind).toBe('device-event')
    })

    it('freezes zone/count/capacity onto the payload subject — capacity is the RULE threshold', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({
          delivery: 'device-event',
          conditions: { occupancy: { op: '>=', count: 2, zoneId: 'z1' } },
        }),
        caller: CALLER,
      })
      h.center.onOccupancyEdge(
        makeOccupancyEdge({ zoneId: 'z1', zoneName: 'Parking', count: 5, threshold: 2 }),
      )
      await waitForOutbox(h.world, 1)
      const payload = outboxPayload(h.world, outboxIds(h.world)[0]!)
      // `count` = the CONFIRMED observed count; `capacity` = the rule's own
      // threshold. Two different numbers — the template must not conflate them.
      expect(payload.subject.occupancy).toEqual({
        zone: 'Parking',
        count: 5,
        capacity: 2,
        occupied: true,
      })
    })

    it('a `<=` rule freezes the RULE count as capacity, not the key threshold (count+1)', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({
          delivery: 'device-event',
          conditions: { occupancy: { op: '<=', count: 1 } },
        }),
        caller: CALLER,
      })
      // `<=1` keys on threshold 2 — the un-occupied edge of key 2.
      h.center.onOccupancyEdge(
        makeOccupancyEdge({ count: 1, previousCount: 2, occupied: false, threshold: 2 }),
      )
      await waitForOutbox(h.world, 1)
      const payload = outboxPayload(h.world, outboxIds(h.world)[0]!)
      expect(payload.subject.occupancy).toEqual({ count: 1, capacity: 1, occupied: false })
    })

    it('a plain device-event (sensor) rule never fires on an occupancy edge (safety gate)', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({
          delivery: 'device-event',
          conditions: { sensorKinds: ['doorbell'] },
        }),
        caller: CALLER,
      })
      h.center.onOccupancyEdge(makeOccupancyEdge())
      await new Promise((r) => setImmediate(r))
      expect(outboxIds(h.world)).toHaveLength(0)
    })

    it('the occupancy hook is inert without evaluation mode', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({
          delivery: 'device-event',
          conditions: { occupancy: { op: 'became-occupied', count: 2 } },
        }),
        caller: CALLER,
      })
      h.center.onOccupancyEdge(makeOccupancyEdge())
      await new Promise((r) => setImmediate(r))
      expect(outboxIds(h.world)).toHaveLength(0)
    })

    it('observeOccupancy feeds the watcher end-to-end (edge fires + confirmed state persists durably)', async () => {
      // Life 1: persist the occupancy rule (no eval needed).
      h = makeHarness()
      await h.center.start({ evaluation: false })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({
          delivery: 'device-event',
          conditions: { occupancy: { op: 'became-occupied', count: 2, sustainSeconds: 0 } },
          throttle: { cooldownSec: 0 },
        }),
        caller: CALLER,
      })
      await h.center.stop()

      // Life 2: the evaluation node boots, loads the rule, watches its key.
      const center2 = new NotificationCenter({
        deviceSettings: makeFakeDeviceSettings(),
        records: h.world.records,
        logger: makeSilentLogger(),
        pruneWindows: ncPruneWindowsPort(),
        dispatcher: {
          listTargets: async () => [
            { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
          ],
          send: async () => ({ success: true }),
          getMediaForOwner: async () => [],
          getDeviceName: async () => null,
        },
        listObjectEventsSince: async () => [],
        listRecentTracks: async () => [],
        now: () => 100_000,
        drainIntervalMs: 3_600_000,
        ruleReloadIntervalMs: 3_600_000,
      })
      await center2.start({ evaluation: true })
      // The first snapshot of a key SEEDS it and fires nothing — an edge needs a
      // transition between two observed snapshots (`occupancy-cold-seed.spec.ts`).
      // Seed the empty frame, then cross.
      center2.observeOccupancy(104, occSnapshot(0))
      // Frame with 2 objects crosses the threshold (sustain 0 → same-tick commit).
      center2.observeOccupancy(104, occSnapshot(2))
      await waitForOutbox(h.world, 1)
      // The confirmed edge-state is durably persisted (survives a restart).
      const occRows = ncTable(h.world, 'occupancy')
      expect(occRows?.size).toBe(1)
      await center2.stop()
    })

    /**
     * The COLD SEED is durable too, not just the edges.
     *
     * `seedState` writes the first observed level into the watcher so an
     * already-parked car does not announce its own arrival. That level lived in
     * RAM only: the write-through fired on committed edges, so every restart
     * threw the baseline away and re-seeded from the first post-boot snapshot.
     * A car that left during the downtime came back as a phantom re-seed and
     * its departure was never announced.
     *
     * Neutralise the fix (drop the `persistSeededOccupancy` call) and the
     * collection is empty here: no edge has committed, and nothing else writes.
     */
    it('observeOccupancy persists the COLD SEED, with no edge involved', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({
          delivery: 'device-event',
          conditions: { occupancy: { op: 'became-occupied', count: 2, sustainSeconds: 0 } },
          throttle: { cooldownSec: 0 },
        }),
        caller: CALLER,
      })
      await h.center.stop()

      const center2 = new NotificationCenter({
        deviceSettings: makeFakeDeviceSettings(),
        records: h.world.records,
        logger: makeSilentLogger(),
        pruneWindows: ncPruneWindowsPort(),
        dispatcher: {
          listTargets: async () => [],
          send: async () => ({ success: true }),
          getMediaForOwner: async () => [],
          getDeviceName: async () => null,
        },
        listObjectEventsSince: async () => [],
        listRecentTracks: async () => [],
        now: () => 100_000,
        drainIntervalMs: 3_600_000,
        ruleReloadIntervalMs: 3_600_000,
      })
      await center2.start({ evaluation: true })

      // ONE snapshot. It seeds the key and fires nothing — and it must still be
      // remembered, because it is the level every later edge is measured from.
      center2.observeOccupancy(104, occSnapshot(3))
      await new Promise((r) => setImmediate(r))

      expect(outboxIds(h.world)).toHaveLength(0)
      const seededRows = ncTable(h.world, 'occupancy')
      expect(seededRows?.size).toBe(1)
      const seeded = [...(seededRows?.values() ?? [])][0] as Record<string, unknown>
      expect(seeded['confirmedCount']).toBe(3)
      expect(seeded['occupied']).toBe(true)
      await center2.stop()
    })
  })

  describe('boot watermark reconcile (crash gap)', () => {
    it('start() re-evaluates events newer than the watermark and advances it', async () => {
      // First life: create the rule + set a watermark, then "crash".
      h = makeHarness()
      await h.center.start({ evaluation: true })
      // cooldown 0 — the reconcile replays BOTH missed fires (a non-zero
      // cooldown would legitimately coalesce the post-downtime burst).
      await h.center
        .buildProvider()
        .createRule({ rule: makeRuleInput({ throttle: { cooldownSec: 0 } }), caller: CALLER })
      await h.center.stop()

      // Events persisted while "down" (newer than watermark 100_000).
      h.events.push(makeEvent({ id: TEST_EV.missed1, trackId: 'trk-m1', timestamp: 150_000 }))
      h.events.push(makeEvent({ id: TEST_EV.missed2, trackId: 'trk-m2', timestamp: 160_000 }))
      h.setNow(200_000)

      // Second life over the SAME store.
      const center2 = new NotificationCenter({
        deviceSettings: makeFakeDeviceSettings(),
        records: h.world.records,
        logger: makeSilentLogger(),
        pruneWindows: ncPruneWindowsPort(),
        dispatcher: {
          listTargets: async () => [
            { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
          ],
          send: async () => ({ success: true }),
          getMediaForOwner: async () => [],
          getDeviceName: async () => null,
        },
        listObjectEventsSince: async (since) => h.events.filter((e) => e.timestamp >= since),
        listRecentTracks: async () => [],
        now: () => 200_000,
        drainIntervalMs: 3_600_000,
        ruleReloadIntervalMs: 3_600_000,
      })
      await center2.start({ evaluation: true })
      // The reconcile is a BACK-FILL phase now — `start()` resolving means the
      // intake is open, not that the crash gap has been replayed.
      await center2.whenHydrated()
      const ids = outboxIds(h.world)
      expect(ids).toHaveLength(2)
      expect(ids.some((id) => id.includes(':trk-m1:'))).toBe(true)
      expect(ids.some((id) => id.includes(':trk-m2:'))).toBe(true)
      await center2.stop()
      // Watermark advanced to "now" → a third boot rescans nothing older.
      const meta = ncTable(h.world, 'meta').get('watermark')!
      expect((meta['value'] as { ts: number }).ts).toBe(200_000)
    })

    it('reconcile is idempotent — already-enqueued intents dedup', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({ rule: makeRuleInput(), caller: CALLER })
      // Live-processed event…
      h.center.onObjectEventPersisted(makeEvent({ id: TEST_EV.live, trackId: 'trk-live' }))
      await waitForOutbox(h.world, 1)
      await h.center.stop()
      // …also visible to the boot scan of the second life.
      h.events.push(makeEvent({ id: TEST_EV.live, trackId: 'trk-live', timestamp: 150_000 }))
      const center2 = new NotificationCenter({
        deviceSettings: makeFakeDeviceSettings(),
        records: h.world.records,
        logger: makeSilentLogger(),
        pruneWindows: ncPruneWindowsPort(),
        dispatcher: {
          listTargets: async () => [],
          send: async () => ({ success: true }),
          getMediaForOwner: async () => [],
          getDeviceName: async () => null,
        },
        listObjectEventsSince: async (since) => h.events.filter((e) => e.timestamp >= since),
        listRecentTracks: async () => [],
        now: () => 200_000,
        drainIntervalMs: 3_600_000,
        ruleReloadIntervalMs: 3_600_000,
      })
      await center2.start({ evaluation: true })
      // Without this the reconcile would not have RUN by the time the
      // assertion reads the store, and "idempotent" would be verified against
      // a replay that never happened.
      await center2.whenHydrated()
      expect(outboxIds(h.world)).toHaveLength(1)
      await center2.stop()
    })
  })

  describe('cap provider', () => {
    it('createRule stamps createdBy from the injected caller', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      const { rule } = await h.center
        .buildProvider()
        .createRule({ rule: makeRuleInput(), caller: CALLER })
      expect(rule.createdBy).toBe('admin-42')
      expect(rule.id).toBeTruthy()
    })

    it('create/update reject rules referencing unknown targets', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      const provider = h.center.buildProvider()
      await expect(
        provider.createRule({
          rule: makeRuleInput({ targets: [{ targetId: 'ghost' }] }),
          caller: CALLER,
        }),
      ).rejects.toThrow('unknown notification target: ghost')
      const { rule } = await provider.createRule({ rule: makeRuleInput(), caller: CALLER })
      await expect(
        provider.updateRule({
          ruleId: rule.id,
          patch: { targets: [{ targetId: 'ghost' }] },
          caller: CALLER,
        }),
      ).rejects.toThrow('unknown notification target: ghost')
    })

    it('list / get / setEnabled / delete round-trip', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      const provider = h.center.buildProvider()
      const { rule } = await provider.createRule({ rule: makeRuleInput(), caller: CALLER })
      expect((await provider.listRules({})).rules).toHaveLength(1)
      expect((await provider.getRule({ ruleId: rule.id })).rule?.name).toBe('person rule')
      await provider.setRuleEnabled({ ruleId: rule.id, enabled: false })
      expect((await provider.getRule({ ruleId: rule.id })).rule?.enabled).toBe(false)
      await provider.deleteRule({ ruleId: rule.id })
      expect((await provider.getRule({ ruleId: rule.id })).rule).toBeNull()
    })

    it('getHistory returns fired deliveries mapped from the outbox, newest-first', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      const provider = h.center.buildProvider()
      await provider.createRule({
        rule: makeRuleInput({ throttle: { cooldownSec: 0 } }),
        caller: CALLER,
      })
      h.center.onObjectEventPersisted(
        makeEvent({ id: TEST_EV.a, trackId: 'trk-a', timestamp: 100_000 }),
      )
      await waitForOutbox(h.world, 1)
      h.setNow(200_000)
      h.center.onObjectEventPersisted(
        makeEvent({ id: TEST_EV.b, trackId: 'trk-b', timestamp: 200_000 }),
      )
      await waitForOutbox(h.world, 2)

      const { entries } = await provider.getHistory({ filter: { limit: 100 } })
      expect(entries).toHaveLength(2)
      // Newest fire first.
      expect(entries.map((e) => e.recordId)).toEqual([String(TEST_EV.b), String(TEST_EV.a)])
      const first = entries[0]!
      expect(first.ruleName).toBe('person rule')
      expect(first.delivery).toBe('immediate')
      expect(first.recordKind).toBe('object-event')
      expect(first.targetId).toBe('tgt-1')
      expect(first.deviceId).toBe(104)
      expect(first.status).toBe('pending')
      expect(first.subject.className).toBe('person')
      expect(first.subject.zones).toEqual(['gate'])
    })

    it('getHistory honours the ruleId / deviceId / limit filter', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      const provider = h.center.buildProvider()
      const { rule } = await provider.createRule({
        rule: makeRuleInput({ throttle: { cooldownSec: 0 } }),
        caller: CALLER,
      })
      h.center.onObjectEventPersisted(makeEvent({ id: TEST_EV.e1, trackId: 't1', deviceId: 104 }))
      await waitForOutbox(h.world, 1)
      h.center.onObjectEventPersisted(makeEvent({ id: TEST_EV.e2, trackId: 't2', deviceId: 102 }))
      await waitForOutbox(h.world, 2)

      const byRule = await provider.getHistory({ filter: { ruleId: rule.id, limit: 100 } })
      expect(byRule.entries).toHaveLength(2)
      const byDevice = await provider.getHistory({ filter: { deviceId: 102, limit: 100 } })
      expect(byDevice.entries.map((e) => e.deviceId)).toEqual([102])
      const bounded = await provider.getHistory({ filter: { limit: 1 } })
      expect(bounded.entries).toHaveLength(1)
    })

    /**
     * The artefact REFERENCE, end to end: a row a delivery marked `sent` with
     * `artifactIds` (exactly what `NcOutbox.attempt` writes — see
     * `outbox.spec.ts`) surfaces those ids through the cap-facing
     * `getHistory` projection, and `resolveArtifactUrl` mints a URL for one
     * through the wired plane closure — never re-deriving anything, just
     * calling what `NotificationCenterDeps.resolveArtifactUrl` was given.
     */
    it('getHistory carries artifactIds, and resolveArtifactUrl resolves one through the wired plane', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: true })
      await h.center.buildProvider().createRule({
        rule: makeRuleInput({ throttle: { cooldownSec: 0 } }),
        caller: CALLER,
      })
      h.center.onObjectEventPersisted(makeEvent({ id: TEST_EV.art, trackId: 'trk-art' }))
      await waitForOutbox(h.world, 1)
      const id = outboxIds(h.world)[0]!
      const rows = ncTable(h.world, 'outbox')!
      const row = rows.get(id)!
      // What `NcOutbox.attempt()` writes on a successful send whose media
      // resolve indexed one still (see `outbox.spec.ts`'s own coverage of
      // that write) — reproduced here directly so this test is about the
      // READ side (`getHistory` / `resolveArtifactUrl`), not the drain timing.
      h.world.seed('outbox', {
        id,
        data: {
          ...row,
          status: 'sent',
          payload: { ...(row['payload'] as NcOutboxPayload), artifactIds: ['art-still'] },
        },
      })

      const resolvedIds: string[] = []
      const center2 = new NotificationCenter({
        deviceSettings: makeFakeDeviceSettings(),
        records: h.world.records,
        logger: makeSilentLogger(),
        pruneWindows: ncPruneWindowsPort(),
        dispatcher: {
          listTargets: async () => [],
          send: async () => ({ success: true }),
          getMediaForOwner: async () => [],
          getDeviceName: async () => null,
        },
        listObjectEventsSince: async () => [],
        listRecentTracks: async () => [],
        now: () => 100_000,
        drainIntervalMs: 3_600_000,
        ruleReloadIntervalMs: 3_600_000,
        resolveArtifactUrl: async (artifactId) => {
          resolvedIds.push(artifactId)
          return artifactId === 'art-still' ? 'https://hub/a/art-still' : null
        },
      })
      try {
        await center2.start({ evaluation: false })
        const provider2 = center2.buildProvider()

        const { entries } = await provider2.getHistory({ filter: { limit: 100 } })
        expect(entries[0]?.artifactIds).toEqual(['art-still'])

        const found = await provider2.resolveArtifactUrl({ artifactId: 'art-still' })
        expect(found.url).toBe('https://hub/a/art-still')
        expect(resolvedIds).toEqual(['art-still'])

        // An id with no live artefact (unknown / expired / pruned) degrades to
        // `null`, never a broken link.
        const missing = await provider2.resolveArtifactUrl({ artifactId: 'gone' })
        expect(missing.url).toBeNull()
      } finally {
        await center2.stop()
      }
    })

    it('getConditionCatalog serves the machine-readable P1 surface', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      const { catalog } = await h.center.buildProvider().getConditionCatalog({})
      expect(catalog.length).toBeGreaterThanOrEqual(10)
      expect(catalog.map((c) => c.id)).toContain('zones')
      // Every descriptor declares a phase. NOT "every phase is P1": that was
      // true the day this was written and forbade the field from ever being
      // used, which is what the `deviceState` (P2) condition tripped over.
      expect(catalog.every((c) => c.phase.length > 0)).toBe(true)
    })

    it('testRule dry-runs an immediate rule against recent events', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      h.events.push(makeEvent({ id: TEST_EV.match, className: 'person', timestamp: 99_000 }))
      h.events.push(makeEvent({ id: TEST_EV.miss, className: 'vehicle', timestamp: 98_000 }))
      const { results } = await h.center.buildProvider().testRule({
        rule: makeRuleInput(),
        lookbackMinutes: 60,
      })
      expect(results).toHaveLength(2)
      const match = results.find((r) => r.recordId === String(TEST_EV.match))!
      const miss = results.find((r) => r.recordId === String(TEST_EV.miss))!
      expect(match.wouldFire).toBe(true)
      expect(match.failedCondition).toBeUndefined()
      expect(miss.wouldFire).toBe(false)
      expect(miss.failedCondition).toBe('classes')
    })

    it('testRule dry-runs a track-end rule against recent tracks', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      h.tracks.push(makeTrack({ trackId: 'trk-ok', lastSeen: 99_500 }))
      h.tracks.push(makeTrack({ trackId: 'trk-no', className: 'vehicle', lastSeen: 99_400 }))
      const { results } = await h.center.buildProvider().testRule({
        rule: makeRuleInput({ delivery: 'track-end' }),
        lookbackMinutes: 60,
      })
      expect(results.map((r) => r.recordKind)).toEqual(['track', 'track'])
      expect(results.find((r) => r.recordId === 'trk-ok')?.wouldFire).toBe(true)
      expect(results.find((r) => r.recordId === 'trk-no')?.wouldFire).toBe(false)
    })

    // A3 MEDIUM-1 regression: the admin cap `updateRule` must NEVER clobber the
    // per-target opt-out set. The widened NcRulePatchSchema now accepts
    // `disabledTargetIds` (for the store-internal setRuleTargetEnabled path), so
    // a stale full-object patch could otherwise reset it.
    it('updateRule preserves an existing per-target opt-out when the patch OMITS disabledTargetIds', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      const provider = h.center.buildProvider()
      const { rule } = await provider.createRule({ rule: makeRuleInput(), caller: CALLER })
      await h.center.ruleStore.setRuleTargetEnabled(rule.id, 'tgt-1', false)
      const { rule: updated } = await provider.updateRule({
        ruleId: rule.id,
        patch: { name: 'renamed' },
        caller: CALLER,
      })
      expect(updated.name).toBe('renamed')
      expect(updated.disabledTargetIds).toEqual(['tgt-1'])
    })

    it('updateRule ignores a stale disabledTargetIds carried in the patch (opt-out unchanged)', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      const provider = h.center.buildProvider()
      const { rule } = await provider.createRule({ rule: makeRuleInput(), caller: CALLER })
      await h.center.ruleStore.setRuleTargetEnabled(rule.id, 'tgt-1', false)
      const { rule: updated } = await provider.updateRule({
        ruleId: rule.id,
        // Stale client snapshot resets the set to empty — must be ignored.
        patch: { name: 'renamed', disabledTargetIds: [] },
        caller: CALLER,
      })
      expect(updated.disabledTargetIds).toEqual(['tgt-1'])
    })

    // `clear: ['targetUsers']` counts as absent for the
    // addressee gate — a rule with no direct targets left ONLY with
    // `targetUsers` must not be allowed to clear its last addressee.
    it('updateRule rejects clearing targetUsers when the rule has no direct targets', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      const provider = h.center.buildProvider()
      const { rule } = await provider.createRule({
        rule: makeRuleInput({ targets: [], targetUsers: ['user-bob'] }),
        caller: CALLER,
      })
      await expect(
        provider.updateRule({
          ruleId: rule.id,
          patch: {},
          clear: ['targetUsers'],
          caller: CALLER,
        }),
      ).rejects.toThrow(/at least one delivery target or user/)
    })

    // With a direct target still present, clearing
    // targetUsers must be allowed AND actually forwarded to the store.
    it('updateRule accepts clearing targetUsers when the rule keeps a direct target, and forwards the clear', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      const provider = h.center.buildProvider()
      const { rule } = await provider.createRule({
        rule: makeRuleInput({ targets: [{ targetId: 'tgt-1' }], targetUsers: ['user-bob'] }),
        caller: CALLER,
      })
      const { rule: updated } = await provider.updateRule({
        ruleId: rule.id,
        patch: {},
        clear: ['targetUsers'],
        caller: CALLER,
      })
      expect(updated.targetUsers).toBeUndefined()
    })

    // A4 carry: a rule carrying `customZones` needs the FULL event projection
    // (bbox + frame dims for object events; envelope for tracks) so the subject
    // carries a normalized bbox — otherwise `customZones` fails closed silently.
    it('testRule fires an immediate customZones rule when the object-event carries bbox + frame dims', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      // Full projection: pixel bbox + frame dims → normalized bbox inside the polygon.
      h.events.push(
        makeEvent({
          id: TEST_EV.zone,
          className: 'person',
          timestamp: 99_000,
          bbox: { x: 100, y: 100, w: 40, h: 40 },
          frameWidth: 1000,
          frameHeight: 1000,
        }),
      )
      const fullFramePolygon = {
        kind: 'polygon' as const,
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
      }
      const { results } = await h.center.buildProvider().testRule({
        rule: makeRuleInput({ conditions: { customZones: [fullFramePolygon] } }),
        lookbackMinutes: 60,
      })
      expect(results.find((r) => r.recordId === String(TEST_EV.zone))?.wouldFire).toBe(true)
    })

    it('testRule fires a track-end customZones rule from the persisted envelope (slim projection safe)', async () => {
      h = makeHarness()
      await h.center.start({ evaluation: false })
      // Slim track rows keep the light envelope columns — the subject bbox
      // derives from them, so a customZones dry-run still matches.
      h.tracks.push(
        makeTrack({
          trackId: 'trk-zone',
          lastSeen: 99_500,
          envelope: { minX: 0.1, minY: 0.1, maxX: 0.4, maxY: 0.4 },
        }),
      )
      const fullFramePolygon = {
        kind: 'polygon' as const,
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
      }
      const { results } = await h.center.buildProvider().testRule({
        rule: makeRuleInput({
          delivery: 'track-end',
          conditions: { customZones: [fullFramePolygon] },
        }),
        lookbackMinutes: 60,
      })
      expect(results.find((r) => r.recordId === 'trk-zone')?.wouldFire).toBe(true)
    })
  })
})
