/**
 * A COOLDOWN IS A BUDGET FOR VOLUME. IT MUST NEVER SWALLOW A DIRECTION.
 *
 * ## The bug this pins, end to end
 *
 * 2026-08-13, live hub. `Eventi di sistema` (`cooldownSec: 60`,
 * `scope: 'rule-device'`) covers `device-offline` AND `device-online`. The
 * cooldown key was `r:<ruleId>:s:device:<id>` — the SUBJECT, with no trace of
 * which way the subject moved. So:
 *
 * ```
 * 20:35:55  device:3219 offline  → matched → enqueued → delivered
 * 20:36:08  device:3219 online   → matched but COOLING DOWN → nothing
 * 20:39:29  device:3219 offline  → matched → enqueued → delivered   ← "duplicate"
 * ```
 *
 * Two consequences, and the second is the one the operator reported:
 *
 *  1. the recovery is LOST — the operator is left believing a camera is down
 *     while it is up, which is the one state a liveness rule exists to deny;
 *  2. because the liveness ledger DID advance to `online` on the suppressed
 *     event (it is a real flip; only the notification was throttled), the next
 *     `offline` is a genuine flip again and notifies — so the operator receives
 *     the same sentence twice with no recovery between, and reads it as a
 *     duplicate.
 *
 * The same shape hit `device:103` (Camera porch) at 05:55:26/05:55:37 on
 * 2026-08-14 — the durable ledger row says `online`, the operator's last
 * message says offline.
 *
 * ## The fix
 *
 * For a SYSTEM event the cooldown key carries the transition's `kind`, so
 * `device-offline` and `device-online` can never share a window. Same
 * reasoning D62 already applied one level up, where `device-switch:<id>` and
 * `device:<id>` were split so the operator's switch and the device's liveness
 * "do not share a dedup slot and cancel each other out".
 *
 * Volume throttling is untouched: two events of the SAME direction inside the
 * window are still suppressed, and every non-system subject keeps its key byte
 * for byte.
 */
import type { InMemoryRecords } from '@camstack/types'
import { createEvent, DeviceType, NcRuleInputSchema, type SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcTargetRef } from '../dispatcher.js'
import { ncPruneWindowsPort, makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { NotificationCenter } from '../index.js'
import type { OccupancyEdge } from '../occupancy-watcher.js'
import { cooldownKey, NC_SYSTEM_DEVICE_ID, type NcRuleSubject } from '../rule-engine.js'
import {
  CALLER,
  DEVICE,
  event,
  type Harness,
  makeHarness,
  payloads,
  restart,
  rule as groupedRule,
  T0,
} from './grouped-harness.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const TARGETS: readonly NcTargetRef[] = [
  {
    id: 'target-1',
    addonId: 'notifiers',
    name: 'phone',
    kind: 'ntfy',
    enabled: true,
  },
]

const centers: NotificationCenter[] = []

afterEach(async () => {
  await Promise.all(centers.map((center) => center.stop()))
  centers.length = 0
})

// ── the key itself ──────────────────────────────────────────────────

function systemSubject(kind: 'device-offline' | 'device-online'): NcRuleSubject {
  return {
    kind: 'system-event',
    recordId: `event-${kind}`,
    deviceId: NC_SYSTEM_DEVICE_ID,
    timestamp: 100,
    classNames: [],
    zones: [],
    systemEvent: {
      kind,
      subject: 'device:3219',
      title: 'x',
      body: 'y',
      deviceId: 3219,
      data: {},
    },
  }
}

function throttledRule(scope: 'rule' | 'rule-device') {
  return { id: 'rule-1', throttle: { cooldownSec: 60, scope } } as const
}

describe('the system-event cooldown key carries the DIRECTION', () => {
  it("scope 'rule-device': offline and online of one device never share a window", () => {
    const rule = throttledRule('rule-device')
    expect(cooldownKey(rule, systemSubject('device-offline'))).not.toBe(
      cooldownKey(rule, systemSubject('device-online')),
    )
  })

  it("scope 'rule': the same, because the DIRECTION is part of the fact, not of the volume", () => {
    const rule = throttledRule('rule')
    expect(cooldownKey(rule, systemSubject('device-offline'))).not.toBe(
      cooldownKey(rule, systemSubject('device-online')),
    )
  })

  it('the SAME direction still shares one window — this is still a throttle', () => {
    const rule = throttledRule('rule-device')
    const first = systemSubject('device-offline')
    const second: NcRuleSubject = { ...first, recordId: 'event-2' }
    expect(cooldownKey(rule, first)).toBe(cooldownKey(rule, second))
  })

  it('a NON-system subject keys per class — the default since 2026-10-01 (D36)', () => {
    const rule = throttledRule('rule-device')
    const detection: NcRuleSubject = {
      kind: 'object-event',
      recordId: 'ev-1',
      deviceId: 104,
      timestamp: 1,
      classNames: ['person'],
      zones: [],
    }
    expect(cooldownKey(rule, detection)).toBe('r:rule-1:d:104:c:person')
    expect(cooldownKey(throttledRule('rule'), detection)).toBe('r:rule-1:c:person')
  })
})

// ── the same thing, wired through the whole centre ──────────────────

async function startCenter(world: InMemoryRecords, now: () => number): Promise<NotificationCenter> {
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: ncPruneWindowsPort(),
    now,
    dispatcher: {
      listTargets: async () => [...TARGETS],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Camera',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [
      {
        deviceId: 3219,
        type: DeviceType.Camera,
        name: 'Camera 3219',
        isCamera: true,
      },
    ],
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: true })
  // The cooldown reseed is a BACK-FILL phase now (`start()` resolving means
  // the intake is open, not that the durable state has been recovered). THIS
  // suite is about the reseed, so it waits for it — a live producer does not,
  // and its cost is at most one repeat inside the first back-fill window.
  await center.whenHydrated()
  return center
}

/** The operator's real rule: 60 s per device, both directions. */
async function createLivenessRule(center: NotificationCenter): Promise<void> {
  await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Eventi di sistema',
      delivery: 'system-event',
      conditions: {
        systemEvent: { kinds: ['device-online', 'device-offline'] },
      },
      targets: [{ targetId: 'target-1' }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 60, scope: 'rule-device' },
    }),
  })
}

function liveness(deviceId: number, online: boolean): SystemEvent {
  return createEvent(
    online ? 'device.online' : 'device.offline',
    { type: 'device', id: deviceId },
    { deviceId, providerId: 'hikvision' },
  )
}

function enqueuedKinds(world: InMemoryRecords): readonly unknown[] {
  return [...(ncTable(world, 'outbox')?.values() ?? [])].map((row) => {
    const payload = row['payload']
    if (payload === null || typeof payload !== 'object') return undefined
    const subject = (payload as Record<string, unknown>)['subject']
    if (subject === null || typeof subject !== 'object') return undefined
    const systemEvent = (subject as Record<string, unknown>)['systemEvent']
    if (systemEvent === null || typeof systemEvent !== 'object') return undefined
    return (systemEvent as Record<string, unknown>)['kind']
  })
}

describe('THE INCIDENT: a recovery inside the cooldown window', () => {
  it('a camera that comes back 13 s after going down is still ANNOUNCED', async () => {
    const world = makeNcRecords()
    let clock = 1_000_000
    const center = await startCenter(world, () => clock)
    await createLivenessRule(center)

    center.onSystemEvent(liveness(3219, true)) // seed the ledger: online
    await vi.waitFor(() => {
      expect(ncTable(world, 'liveness')?.get('device:3219')).toMatchObject({
        state: 'online',
      })
    })

    clock += 1_000
    center.onSystemEvent(liveness(3219, false)) // the outage — notified
    clock += 13_000 // …13 s later, well inside the 60 s window
    center.onSystemEvent(liveness(3219, true)) // the recovery — MUST notify

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(2)
    })
    expect(enqueuedKinds(world)).toEqual(['device-offline', 'device-online'])
  })

  it('CONTROL: the throttle still works — a second outage inside the window says nothing', async () => {
    const world = makeNcRecords()
    let clock = 2_000_000
    const center = await startCenter(world, () => clock)
    await createLivenessRule(center)

    // The evaluation chain is serialized and asynchronous, so each step is
    // settled before the clock moves — otherwise every event would be judged
    // against the LAST value of `clock` and the test would prove nothing.
    const settle = async (rows: number): Promise<void> => {
      await vi.waitFor(() => {
        expect(ncTable(world, 'outbox')?.size ?? 0).toBe(rows)
      })
    }

    center.onSystemEvent(liveness(3219, true)) // seed: online
    await settle(0)
    clock += 1_000
    center.onSystemEvent(liveness(3219, false)) // outage — notified
    await settle(1)
    clock += 5_000
    center.onSystemEvent(liveness(3219, true)) // recovery — notified (the fix)
    await settle(2)
    clock += 5_000
    center.onSystemEvent(liveness(3219, false)) // SECOND outage, 10 s after the first
    // …suppressed: same rule, same device, same DIRECTION, inside 60 s.
    await settle(2)

    // The window opens, and the next pair is finally allowed through.
    clock += 61_000
    center.onSystemEvent(liveness(3219, true)) // recovery (its own window is open)
    await settle(3)
    clock += 1_000
    center.onSystemEvent(liveness(3219, false)) // outage — notified
    await settle(4)
    expect(enqueuedKinds(world)).toEqual([
      'device-offline',
      'device-online',
      'device-online',
      'device-offline',
    ])
  })

  it('the cooldown map REBUILT at boot addresses the same key the live path computes', async () => {
    const world = makeNcRecords()
    let clock = 3_000_000
    const first = await startCenter(world, () => clock)
    await createLivenessRule(first)

    first.onSystemEvent(liveness(3219, true)) // seed: online
    clock += 1_000
    first.onSystemEvent(liveness(3219, false)) // outage — one row
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    await first.stop()

    // The runner respawns 5 s later. `seedCooldowns` rebuilds the windows from
    // the persisted rows — with the SAME key builder, or the throttle silently
    // stops working across every restart.
    clock += 5_000
    const second = await startCenter(world, () => clock)
    second.onSystemEvent(liveness(3219, true)) // recovery: its own window, fires
    clock += 1_000
    second.onSystemEvent(liveness(3219, false)) // outage again — STILL cooling down

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(2)
    })
    expect(enqueuedKinds(world)).toEqual(['device-offline', 'device-online'])
  })
})

/**
 * The same seam, one level over: the boot reseed now calls `cooldownKey`
 * itself rather than rebuilding the string.
 *
 * `notifications.md` had carried this as a known defect since 2026-08-02 —
 * `seedCooldowns` knew the `r:<id>` / `r:<id>:d:<device>` shapes and not the
 * `:c:<class>` tail, so a `per-class` (or audio) rule's window was never
 * reseeded and re-fired immediately after every respawn. On this hub the
 * pipeline-analytics runner respawns several times an hour, so "after a
 * restart" is not a rare condition.
 */
describe('the cooldown reseed addresses EVERY window the live path can open', () => {
  it("a 'per-class' window survives the restart it was written to survive", async () => {
    const world = makeNcRecords()
    let clock = 4_000_000
    const first = await startCenter(world, () => clock)
    await first.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Persona',
        delivery: 'immediate',
        conditions: { classes: ['person', 'vehicle'] },
        targets: [{ targetId: 'target-1' }],
        media: { attach: 'none' },
        throttle: { cooldownSec: 60, scope: 'rule-device', granularity: 'per-class' },
      }),
    })
    first.onObjectEventPersisted({
      id: 100_001,
      kind: 'object',
      deviceId: 3219,
      timestamp: clock,
      trackId: 'trk-1',
      className: 'person',
      confidence: 0.9,
      zones: [],
    })
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    await first.stop()

    // The runner respawns 5 s later. The window has 55 s left on it.
    clock += 5_000
    const second = await startCenter(world, () => clock)
    second.onObjectEventPersisted({
      id: 100_002,
      kind: 'object',
      deviceId: 3219,
      timestamp: clock,
      trackId: 'trk-2',
      className: 'person',
      confidence: 0.9,
      zones: [],
    })

    // CONTROL: a DIFFERENT class has its own window and must still fire, so
    // the count below is a reseeded suppression and not a dead path.
    second.onObjectEventPersisted({
      id: 100_003,
      kind: 'object',
      deviceId: 3219,
      timestamp: clock,
      trackId: 'trk-3',
      className: 'vehicle',
      confidence: 0.9,
      zones: [],
    })

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(2)
    })
    const classes = [...(ncTable(world, 'outbox')?.values() ?? [])].map((row) => {
      const payload = row['payload']
      if (payload === null || typeof payload !== 'object') return undefined
      const subject = (payload as Record<string, unknown>)['subject']
      if (subject === null || typeof subject !== 'object') return undefined
      return (subject as Record<string, unknown>)['className']
    })
    expect(classes).toEqual(['person', 'vehicle'])
  })
})

/**
 * Occupancy rows are PERSISTED as `device-event` (the delivery they ride) but
 * keyed LIVE as `occupancy-event`, a class-bearing kind — so since the
 * per-class default (D36, 2026-10-01) the live key carries `:c:<class>`. A
 * reseed that rebuilt the row as a plain `device-event` addressed the
 * class-less key instead, and every occupancy rule's window evaporated on each
 * pipeline-analytics respawn (several times an hour on this hub).
 */
describe('an OCCUPANCY window survives the restart too', () => {
  function edge(className: string, timestamp: number): OccupancyEdge {
    return {
      deviceId: 3219,
      className,
      count: 1,
      previousCount: 0,
      occupied: true,
      threshold: 1,
      timestamp,
    }
  }

  async function createOccupancyRule(center: NotificationCenter, className: string): Promise<void> {
    await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: `Posto ${className}`,
        delivery: 'device-event',
        conditions: { occupancy: { op: 'became-occupied', count: 1, className } },
        targets: [{ targetId: 'target-1' }],
        media: { attach: 'none' },
        // granularity UNSET — the default, which now keys per class.
        throttle: { cooldownSec: 60, scope: 'rule-device' },
      }),
    })
  }

  it('the reseeded key is the per-class key the live occupancy path writes', async () => {
    const world = makeNcRecords()
    let clock = 5_000_000
    const first = await startCenter(world, () => clock)
    await createOccupancyRule(first, 'car')
    await createOccupancyRule(first, 'truck')

    first.onOccupancyEdge(edge('car', clock))
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    await first.stop()

    // The runner respawns 5 s later; the car window has 55 s left on it.
    clock += 5_000
    const second = await startCenter(world, () => clock)
    second.onOccupancyEdge(edge('car', clock)) // MUST be suppressed
    // CONTROL, and a sentinel: the evaluation chain is serialized, so once the
    // truck row lands the car edge above has been judged.
    second.onOccupancyEdge(edge('truck', clock))

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(2)
    })
    const classes = [...(ncTable(world, 'outbox')?.values() ?? [])].map((row) => {
      const payload = row['payload']
      if (payload === null || typeof payload !== 'object') return undefined
      const subject = (payload as Record<string, unknown>)['subject']
      if (subject === null || typeof subject !== 'object') return undefined
      return (subject as Record<string, unknown>)['className']
    })
    expect(classes).toEqual(['car', 'truck'])
  })
})

/**
 * D692 §3.6: a GROUPED close stamps one cooldown key per distinct member class, on the
 * primary's subject. Its row must reseed every one of them — a reseed that rebuilt only the
 * row's single subject (the primary's class) let every OTHER class of the message open a
 * fresh window right after each respawn.
 */
describe('a grouped window survives the restart too', () => {
  const harnesses: Harness[] = []
  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.center.stop()
  })

  it('a grouped row with a person and a dog reseeds BOTH class keys, equal to the live ones', async () => {
    const a = makeHarness()
    harnesses.push(a)
    await a.center.start({ evaluation: true })
    await a.center.whenHydrated()
    const created = await a.center.buildProvider().createRule({
      caller: CALLER,
      rule: groupedRule({
        conditions: { classes: ['person', 'dog', 'cat'] },
        throttle: { cooldownSec: 60, scope: 'rule-device', granularity: 'per-class' },
      }),
    })
    a.center.onObjectEventPersisted(event({ trackId: 'trk-1', className: 'person', timestamp: T0 }))
    a.center.onObjectEventPersisted(
      event({ trackId: 'dog-1', className: 'dog', timestamp: T0 + 1_000 }),
    )
    await a.settle()
    await a.tick(T0 + 21_000)
    expect(payloads(a.world)).toHaveLength(1)
    await a.center.stop()

    // The runner respawns 9 s after the close: both class windows have 51 s left.
    const b = makeHarness({ world: a.world, startAt: T0 + 30_000 })
    harnesses.push(b)
    await restart(b)
    const person = event({ trackId: 'trk-5', className: 'person', timestamp: T0 + 30_000 })
    const dog = event({ trackId: 'dog-5', className: 'dog', timestamp: T0 + 30_000 })
    b.center.onObjectEventPersisted(person)
    b.center.onObjectEventPersisted(dog)
    await b.settle()

    const liveKey = (className: string): string =>
      cooldownKey(created.rule, {
        kind: 'object-event',
        recordId: 'x',
        deviceId: DEVICE,
        timestamp: T0,
        classNames: [className],
        zones: [],
      })
    const cooling = b.linesOf('rule matched but is cooling down').map((l) => l.meta['key'])
    expect(cooling).toEqual([liveKey('person'), liveKey('dog')])
    expect(b.linesOf('grouped window opened')).toHaveLength(0)

    // CONTROL: a class the message did not carry has no window and still opens one, so the
    // two refusals above are the reseed and not a dead path.
    b.center.onObjectEventPersisted(
      event({ trackId: 'cat-5', className: 'cat', timestamp: T0 + 30_000 }),
    )
    await b.settle()
    expect(b.linesOf('grouped window opened')).toHaveLength(1)
  })
})
