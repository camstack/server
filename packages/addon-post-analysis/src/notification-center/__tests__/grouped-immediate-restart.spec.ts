/**
 * D692 Task 10 — a grouped window survives a respawn (spec §5, plan C5 and C9).
 *
 * Every case runs TWO real centres over ONE fake store: centre A lives, then "crashes"
 * (no `stop()`, so no shutdown close); centre B boots over A's store, and its back-fill
 * hydrates the notified set (the `outbox` phase), reseeds the cooldowns and replays the
 * crash gap (the `reconcile` phase). A is stopped only in `afterEach`, after every
 * assertion, so its shutdown close can never be what a case observed.
 *
 *  - the watermark never passes an open window, so the replay re-opens it;
 *  - the replay is timed on the EVENTS' clock and kept apart from live windows;
 *  - a replayed event older than the persisted watermark never OPENS a window;
 *  - THE exactly-once guard after a crash is the notified-set hydration from the outbox
 *    rows — not the dedup id, which a replay under a different window key does not match.
 */

import { NC_GROUPING_MAX_SEC, type ObjectEvent } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import type { InMemoryRecords } from '@camstack/types'
import { withNcFaults } from './support/nc-test-deps.js'
import { RECONCILE_OVERLAP_MS, RECONCILE_SCAN_LIMIT } from '../index.js'
import type { NcRuleStatus } from '../rule-status.js'
import { isGroupV2, readOutboxGroup } from '../grouped/grouped-payload.js'
import { NC_OUTBOX_RECENT_QUERY_LIMIT } from '../outbox.js'
import { NcTestEventInputSchema } from '../test-event.js'
import {
  boot,
  CALLER,
  DEVICE,
  event,
  type Harness,
  type HarnessOptions,
  makeHarness,
  payloads,
  persistedWatermark,
  restart,
  rule,
  T0,
  track,
} from './grouped-harness.js'

const NO_COOLDOWN = { throttle: { cooldownSec: 0, scope: 'rule-device' } } as const

interface ReplayGroup {
  readonly key: string
  readonly closeReason: string | undefined
  readonly members: readonly string[]
}

/** Every grouped row in the store: its key, close reason and member track ids. */
function groupedRows(h: Harness): ReplayGroup[] {
  return payloads(h.world).flatMap((p) => {
    const view = readOutboxGroup(p.group)
    if (view === undefined) return []
    const group = p.group
    return [
      {
        key: view.key,
        closeReason: group !== undefined && 'closeReason' in group ? group.closeReason : undefined,
        members: view.members.map((m) => m.trackId),
      },
    ]
  })
}

/** The persisted object events the boot reconcile scans. */
function eventLog(): {
  readonly events: ObjectEvent[]
  readonly list: NonNullable<HarnessOptions['listObjectEventsSince']>
} {
  const events: ObjectEvent[] = []
  return {
    events,
    list: async (since) => events.filter((e) => e.timestamp >= since),
  }
}

describe('a grouped window survives a respawn (D692 Task 10)', () => {
  const centres: Harness[] = []
  function harness(options: HarnessOptions = {}): Harness {
    const h = makeHarness(options)
    centres.push(h)
    return h
  }
  afterEach(async () => {
    for (const h of centres.splice(0)) await h.center.stop()
  })

  it('1. crash with an open window: the watermark held at its opening, the replay re-sends it under the SAME key', async () => {
    const log = eventLog()
    const a = harness({ listObjectEventsSince: log.list })
    await boot(a)
    const e1 = event({ trackId: 'trk-1', timestamp: T0 })
    const e2 = event({ trackId: 'trk-2', timestamp: T0 + 1_000 })
    log.events.push(e1, e2)
    a.center.onObjectEventPersisted(e1)
    a.center.onObjectEventPersisted(e2)
    await a.settle()
    // Fifteen drain ticks inside the window: exactly one of them persists the watermark.
    for (let i = 1; i <= 15; i += 1) await a.tick(T0 + 1_000 + i * 500)
    const open = a.center.groupedOpenWindows()
    expect(open).toHaveLength(1)
    const key = open[0]?.key
    expect(key).toBe(`grp:${open[0]?.ruleId}:${String(DEVICE)}:trk-1@${String(T0)}`)
    // Spec §5: the watermark never passes an open window.
    const watermark = persistedWatermark(a.world)
    expect(watermark).toBeDefined()
    expect(watermark).toBeLessThanOrEqual(T0)

    // CRASH: no stop(), no shutdown close. Centre B boots 30 s later over the same store.
    const b = harness({ world: a.world, startAt: T0 + 30_000, listObjectEventsSince: log.list })
    await restart(b)

    expect(groupedRows(b)).toEqual([{ key, closeReason: 'replayed', members: ['trk-1', 'trk-2'] }])
  })

  it('2. crash AFTER the enqueue: the notified-set hydration is the exactly-once guard (C9) — a replay under a different key sends nothing', async () => {
    const log = eventLog()
    const a = harness({ listObjectEventsSince: log.list })
    await boot(a, rule(NO_COOLDOWN))
    const e1 = event({ trackId: 'trk-1', timestamp: T0 })
    const e2 = event({ trackId: 'trk-2', timestamp: T0 + 1_000 })
    log.events.push(e1, e2)
    a.center.onObjectEventPersisted(e1)
    a.center.onObjectEventPersisted(e2)
    await a.settle()
    // A fusion between the open and the crash: the replay resolves trk-1 to trk-9, so its
    // window key (`…:trk-9@T0`) is NOT the key of the row A wrote (`…:trk-1@T0`) and the
    // dedup id cannot swallow it. Only the hydrated notified set can.
    a.center.onTracksFused({ deviceId: DEVICE, survivorId: 'trk-9', absorbedId: 'trk-1' })
    await a.settle()
    await a.tick(T0 + 21_000)
    const sent = groupedRows(a)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.key).toContain(':trk-1@')
    expect(sent[0]?.members).toEqual(['trk-9', 'trk-2'])

    // CRASH before the watermark moved past T0.
    expect(persistedWatermark(a.world)).toBeLessThanOrEqual(T0)
    const b = harness({
      world: a.world,
      startAt: T0 + 40_000,
      listObjectEventsSince: log.list,
      resolveTrackAlias: async (id) => (id === 'trk-1' ? 'trk-9' : null),
    })
    await restart(b)

    expect(groupedRows(b)).toHaveLength(1)
    expect(b.linesOf('grouped window opened')).toHaveLength(0)
    const refused = b.linesOf('grouped window: track already notified by this rule')
    expect(refused.map((l) => l.meta['trackId'])).toEqual(['trk-9', 'trk-2'])
    expect(refused.every((l) => l.tags['deviceId'] === DEVICE)).toBe(true)
  })

  it('4. a drain tick during the replay never closes the replaying window — only the release does', async () => {
    const log = eventLog()
    const a = harness({ listObjectEventsSince: log.list })
    await boot(a)
    const e1 = event({ trackId: 'trk-1', timestamp: T0 })
    const e2 = event({ trackId: 'trk-2', timestamp: T0 + 1_000 })
    log.events.push(e1, e2)
    a.center.onObjectEventPersisted(e1)
    a.center.onObjectEventPersisted(e2)
    await a.settle()

    let b: Harness | undefined
    let ticks = 0
    b = harness({
      world: a.world,
      startAt: T0 + 30_000,
      listObjectEventsSince: log.list,
      // Runs ON the chain while trk-1 is being replayed: a drain tick fires right then.
      resolveTrackAlias: async () => {
        if (b !== undefined && ticks === 0) {
          ticks += 1
          void b.center.drainNow()
        }
        return null
      },
    })
    await restart(b)
    await b.settle()

    expect(ticks).toBe(1)
    const rows = groupedRows(b)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.closeReason).toBe('replayed')
    expect(rows[0]?.members).toEqual(['trk-1', 'trk-2'])
  })

  it('5. hydration: a track a persisted grouped row named is already notified after the boot', async () => {
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))
    a.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 }))
    await a.settle()
    await a.tick(T0 + 21_000)
    expect(groupedRows(a)).toHaveLength(1)
    await a.center.stop()

    const b = harness({ world: a.world, startAt: T0 + 60_000 })
    await restart(b)
    b.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 + 60_000 }))
    await b.settle()

    expect(b.center.groupedOpenWindows()).toHaveLength(0)
    expect(b.linesOf('grouped window opened')).toHaveLength(0)
    const refused = b.linesOf('grouped window: track already notified by this rule')
    expect(refused).toHaveLength(1)
    expect(refused[0]?.meta['trackId']).toBe('trk-1')
    expect(refused[0]?.tags['deviceId']).toBe(DEVICE)
  })

  it('5b. hydration: a PLAIN row of a rule since switched to grouped covers its track too', async () => {
    const a = harness()
    const ruleId = await boot(a, rule({ ...NO_COOLDOWN, groupingSec: undefined }))
    a.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 }))
    await a.settle()
    expect(payloads(a.world)).toHaveLength(1)
    expect(payloads(a.world)[0]?.group).toBeUndefined()
    await a.center
      .buildProvider()
      .updateRule({ ruleId, patch: { groupingSec: 20 }, caller: CALLER })
    await a.center.stop()

    const b = harness({ world: a.world, startAt: T0 + 60_000 })
    await restart(b)
    b.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 + 60_000 }))
    await b.settle()

    expect(b.linesOf('grouped window opened')).toHaveLength(0)
    expect(
      b
        .linesOf('grouped window: track already notified by this rule')
        .map((l) => l.meta['trackId']),
    ).toEqual(['trk-1'])
  })

  it('5c. a hydration read that FAILS is said — never an empty set that reads as "nothing was sent" (D393)', async () => {
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))
    await a.center.stop()

    const b = harness({
      world: withNcFaults(a.world, { read: () => 'settings store unavailable' }),
      startAt: T0 + 60_000,
    })
    await restart(b)

    const failed = b.linesOf(
      'grouped notified-track hydration failed — a replayed window is guarded by the dedup id only',
    )
    expect(failed).toHaveLength(1)
    expect(failed[0]?.level).toBe('warn')
    expect(b.linesOf('grouped notified tracks hydrated from the outbox')).toHaveLength(0)
  })

  it('5d. hydration: a tester row never enters the notified set (C11)', async () => {
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))
    await a.center.injectTestEvent(
      NcTestEventInputSchema.parse({
        trigger: 'object-event',
        deviceId: DEVICE,
        classNames: ['person'],
        confidence: 0.9,
        zones: [],
        still: 'none',
      }),
    )
    a.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 }))
    await a.settle()
    await a.tick(T0 + 21_000)
    const rows = payloads(a.world)
    expect(rows).toHaveLength(2)
    expect(rows.filter((p) => p.synthetic === true)).toHaveLength(1)
    await a.center.stop()

    const b = harness({ world: a.world, startAt: T0 + 60_000 })
    await restart(b)

    const hydrated = b.linesOf('grouped notified tracks hydrated from the outbox')
    expect(hydrated).toHaveLength(1)
    expect(hydrated[0]?.meta['rows']).toBe(2)
    expect(hydrated[0]?.meta['tracks']).toBe(1)
  })

  it('7. the replay is timed on the events’ clock: three final members replayed 10 min late are ONE window', async () => {
    const log = eventLog()
    const a = harness({ listObjectEventsSince: log.list })
    await boot(a, rule({ ...NO_COOLDOWN, conditions: { classes: ['dog'] } }))
    log.events.push(
      event({ trackId: 'dog-1', className: 'dog', timestamp: T0 }),
      event({ trackId: 'dog-2', className: 'dog', timestamp: T0 + 1_000 }),
      event({ trackId: 'dog-3', className: 'dog', timestamp: T0 + 3_000 }),
    )

    const b = harness({ world: a.world, startAt: T0 + 600_000, listObjectEventsSince: log.list })
    for (const id of ['dog-1', 'dog-2', 'dog-3']) b.outlooks.set(id, { final: true })
    await restart(b)

    expect(groupedRows(b)).toEqual([
      {
        key: expect.stringContaining(`:dog-1@${String(T0)}`),
        closeReason: 'replayed',
        members: ['dog-1', 'dog-2', 'dog-3'],
      },
    ])
  })

  it('4b. the status of the rule never lists a REPLAYING window (its deadline is on the events’ clock)', async () => {
    const log = eventLog()
    const a = harness({ listObjectEventsSince: log.list })
    const ruleId = await boot(a)
    const stored = (await a.center.buildProvider().getRule({ ruleId })).rule
    if (stored === null) throw new Error('rule not stored')
    const e1 = event({ trackId: 'trk-1', timestamp: T0 })
    const e2 = event({ trackId: 'trk-2', timestamp: T0 + 1_000 })
    log.events.push(e1, e2)
    a.center.onObjectEventPersisted(e1)
    a.center.onObjectEventPersisted(e2)
    await a.settle()

    let b: Harness | undefined
    let during: Promise<NcRuleStatus> | undefined
    let resolved = 0
    b = harness({
      world: a.world,
      startAt: T0 + 30_000,
      listObjectEventsSince: log.list,
      // The second resolution runs while the replaying window of trk-1 is open.
      resolveTrackAlias: async () => {
        resolved += 1
        if (b !== undefined && resolved === 2) during = b.center.ruleStatusFor(stored)
        return null
      },
    })
    await restart(b)
    await b.settle()

    expect(during).toBeDefined()
    expect(await during).toMatchObject({ kind: 'grouped', openWindows: [] })
  })

  it('7b. a replayed event past a replaying window’s deadline closes that window first, then opens its own', async () => {
    const log = eventLog()
    const a = harness({ listObjectEventsSince: log.list })
    await boot(a, rule({ ...NO_COOLDOWN, conditions: { classes: ['dog'] } }))
    log.events.push(
      event({ trackId: 'dog-1', className: 'dog', timestamp: T0 }),
      // groupingSec 20: the first window's deadline is T0+20 s on the EVENT clock.
      event({ trackId: 'dog-2', className: 'dog', timestamp: T0 + 25_000 }),
    )

    const b = harness({ world: a.world, startAt: T0 + 600_000, listObjectEventsSince: log.list })
    await restart(b)

    expect(groupedRows(b)).toEqual([
      {
        key: expect.stringContaining(`:dog-1@${String(T0)}`),
        closeReason: 'replayed',
        members: ['dog-1'],
      },
      {
        key: expect.stringContaining(`:dog-2@${String(T0 + 25_000)}`),
        closeReason: 'replayed',
        members: ['dog-2'],
      },
    ])
  })

  it('8. a replayed event below the replay slack (watermark − 60 s) never opens a window', async () => {
    const events: ObjectEvent[] = []
    // A scan that hands back rows below its own `since` — the gate is the delivery's, not
    // the store's.
    const list: NonNullable<HarnessOptions['listObjectEventsSince']> = async () => events
    // A booted at T0+100 s with nothing open: its reconcile persisted the watermark there.
    const a = harness({ startAt: T0 + 100_000, listObjectEventsSince: list })
    await boot(a, rule({ ...NO_COOLDOWN, conditions: { classes: ['dog'] } }))
    expect(persistedWatermark(a.world)).toBe(T0 + 100_000)
    // Both events are older than watermark − RECONCILE_OVERLAP_MS (T0+40 s).
    events.push(
      event({ trackId: 'dog-1', className: 'dog', timestamp: T0 }),
      event({ trackId: 'dog-2', className: 'dog', timestamp: T0 + 10_000 }),
    )

    const b = harness({ world: a.world, startAt: T0 + 110_000, listObjectEventsSince: list })
    for (const id of ['dog-1', 'dog-2']) b.outlooks.set(id, { final: true })
    await restart(b)

    expect(groupedRows(b)).toHaveLength(0)
    expect(b.linesOf('grouped window opened')).toHaveLength(0)
    const skipped = b.linesOf('replayed event predates the watermark — no window opened')
    expect(skipped.map((l) => l.meta['trackId'])).toEqual(['dog-1', 'dog-2'])
    expect(skipped.every((l) => l.level === 'debug' && l.tags['deviceId'] === DEVICE)).toBe(true)
    expect(skipped[0]?.meta['watermark']).toBe(T0 + 100_000)
    // D391: the replay says how many it refused — once overall, once per camera.
    const perCamera = b.linesOf('grouped replay: events older than the watermark opened no window')
    expect(perCamera.map((l) => [l.level, l.tags['deviceId'], l.meta['refused']])).toEqual([
      ['info', DEVICE, 2],
    ])
    const summary = b.linesOf('grouped replay released')
    expect(summary).toHaveLength(1)
    expect(summary[0]?.level).toBe('info')
    expect(summary[0]?.meta['refused']).toBe(2)
    expect(summary[0]?.meta['watermark']).toBe(T0 + 100_000)
  })

  it('9. a live window opened before the reconcile never receives a replayed subject', async () => {
    const log = eventLog()
    const a = harness({ listObjectEventsSince: log.list })
    await boot(a)
    log.events.push(
      event({ trackId: 'trk-1', timestamp: T0 }),
      event({ trackId: 'trk-2', timestamp: T0 + 1_000 }),
    )

    let releaseScan: () => void = () => undefined
    const scanHeld = new Promise<void>((resolve) => {
      releaseScan = resolve
    })
    const b = harness({
      world: a.world,
      startAt: T0 + 40_000,
      listObjectEventsSince: async (since, limit) => {
        await scanHeld
        return log.list(since, limit)
      },
    })
    await b.center.start({ evaluation: true })
    // The intake is open, the back-fill is not done: a LIVE subject opens a live window.
    b.center.onObjectEventPersisted(event({ trackId: 'trk-3', timestamp: T0 + 40_000 }))
    await b.settle()
    const live = b.center.groupedOpenWindows()
    expect(live).toHaveLength(1)
    expect(live[0]?.replaying).toBe(false)
    const liveKey = live[0]?.key

    releaseScan()
    await b.center.whenHydrated()
    await b.settle()

    // The replay had its own window: past its deadline at release, it closed `replayed`.
    expect(groupedRows(b)).toEqual([
      {
        key: expect.stringContaining(`:trk-1@${String(T0)}`),
        closeReason: 'replayed',
        members: ['trk-1', 'trk-2'],
      },
    ])
    // The live window kept its own key and only its own subject.
    const after = b.center.groupedOpenWindows()
    expect(after).toHaveLength(1)
    expect(after[0]?.key).toBe(liveKey)
    expect(after[0]?.members.map((m) => m.trackId)).toEqual(['trk-3'])
  })
})

/** Drain ticks until one of them persists the watermark (it is written every 15th tick). */
async function persistWatermark(h: Harness): Promise<void> {
  for (let i = 0; i < 15; i += 1) await h.center.drainNow()
}

/** A world over `base` whose first `failures` recent-rows reads (the boot's 24 h read) throw. */
function flakyRecentRows(base: InMemoryRecords, failures: number): InMemoryRecords {
  let left = failures
  return withNcFaults(base, {
    read: (kind, query) => {
      // The recent-rows read is the outbox's only NEWEST-FIRST read at boot
      // (it pages: the limit is a page size, not NC_OUTBOX_RECENT_QUERY_LIMIT).
      if (kind !== 'outbox' || query?.desc !== true || left <= 0) return null
      left -= 1
      return 'settings store busy'
    },
  })
}

describe('a grouped window survives a respawn — review T10 fix round 1', () => {
  const centres: Harness[] = []
  const gates: (() => void)[] = []
  function harness(options: HarnessOptions = {}): Harness {
    const h = makeHarness(options)
    centres.push(h)
    return h
  }
  afterEach(async () => {
    for (const open of gates.splice(0)) open()
    for (const h of centres.splice(0)) await h.center.stop()
  })

  it('HIGH-1a (P1): a watermark written while a close is IN FLIGHT holds at that window — the crash replays it', async () => {
    const log = eventLog()
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    gates.push(() => open())
    let hang = false
    const a = harness({
      listObjectEventsSince: log.list,
      // The close's user fan-out hangs: the window is out of the buffer, its row unwritten.
      listUsers: async () => {
        if (hang) await gate
        return []
      },
      getDeviceRoute: async () => ({ stableId: 'cam', addonId: 'provider' }),
    })
    await boot(a, rule({ ...NO_COOLDOWN, targetUsers: ['someone'] }))
    const e1 = event({ trackId: 'trk-1', timestamp: T0 })
    log.events.push(e1)
    a.center.onObjectEventPersisted(e1)
    await a.settle()
    hang = true
    a.setNow(T0 + 21_000)
    await persistWatermark(a)
    expect(a.center.groupedOpenWindows()).toHaveLength(0)
    expect(groupedRows(a)).toHaveLength(0)
    expect(persistedWatermark(a.world)).toBeLessThanOrEqual(T0)

    // CRASH before the close lands.
    const b = harness({ world: a.world, startAt: T0 + 40_000, listObjectEventsSince: log.list })
    await restart(b)

    expect(groupedRows(b)).toEqual([
      {
        key: expect.stringContaining(`:trk-1@${String(T0)}`),
        closeReason: 'replayed',
        members: ['trk-1'],
      },
    ])
  })

  it('HIGH-1b (P4): an event evaluated just AFTER a watermark write that passed its timestamp is replayed after a crash', async () => {
    const log = eventLog()
    const a = harness({ listObjectEventsSince: log.list, startAt: T0 - 10_000 })
    await boot(a, rule(NO_COOLDOWN))
    // Nothing open: the periodic write puts the watermark at the wall clock.
    a.setNow(T0 + 300)
    await persistWatermark(a)
    expect(persistedWatermark(a.world)).toBe(T0 + 300)
    // The event detected at T0 reaches the centre 300 ms later (persist lag).
    const e1 = event({ trackId: 'trk-1', timestamp: T0 })
    log.events.push(e1)
    a.center.onObjectEventPersisted(e1)
    await a.settle()
    expect(a.center.groupedOpenWindows()).toHaveLength(1)

    // CRASH inside the window, before the next periodic write.
    const b = harness({ world: a.world, startAt: T0 + 10_000, listObjectEventsSince: log.list })
    await restart(b)
    await b.tick(T0 + 40_000)

    expect(groupedRows(b)).toEqual([
      {
        key: expect.stringContaining(`:trk-1@${String(T0)}`),
        closeReason: 'deadline',
        members: ['trk-1'],
      },
    ])
    expect(b.linesOf('replayed event predates the watermark — no window opened')).toHaveLength(0)
    expect(b.linesOf('grouped replay released')[0]?.meta['refused']).toBe(0)
  })

  it('HIGH-1b: a replayed event inside the slack whose window was SENT is refused by the hydration — still one row', async () => {
    const log = eventLog()
    const a = harness({ listObjectEventsSince: log.list })
    await boot(a, rule(NO_COOLDOWN))
    const e1 = event({ trackId: 'trk-1', timestamp: T0 })
    log.events.push(e1)
    a.center.onObjectEventPersisted(e1)
    await a.settle()
    await a.tick(T0 + 21_000)
    expect(groupedRows(a)).toHaveLength(1)
    // Nothing open any more: the watermark moves past the sent window.
    a.setNow(T0 + 30_000)
    await persistWatermark(a)
    expect(persistedWatermark(a.world)).toBe(T0 + 30_000)

    const b = harness({ world: a.world, startAt: T0 + 40_000, listObjectEventsSince: log.list })
    await restart(b)
    await b.tick(T0 + 70_000)

    expect(groupedRows(b)).toHaveLength(1)
    expect(
      b
        .linesOf('grouped window: track already notified by this rule')
        .map((l) => l.meta['trackId']),
    ).toEqual(['trk-1'])
  })

  it('LOW-5: a late-recognition window holds the watermark at its member’s frozen moment — a crash replays from there', async () => {
    const identityRule = { classes: ['person'], identities: ['id-a'] }
    const log = eventLog()
    const a = harness({ listObjectEventsSince: log.list })
    await boot(a, rule({ ...NO_COOLDOWN, conditions: identityRule }))
    const judged = event({ trackId: 'trk-2', timestamp: T0 })
    log.events.push(judged)
    a.center.onObjectEventPersisted(judged)
    await a.settle()
    await a.tick(T0 + 20_000)
    expect(a.linesOf('grouped member dropped — recognition-not-final')).toHaveLength(1)
    // The late recognition re-opens a window at T0+90 s; its member is frozen at T0.
    a.setNow(T0 + 90_000)
    a.center.onTrackLabelChanged({
      deviceId: DEVICE,
      trackId: 'trk-2',
      change: 'accepted',
      label: { label: 'Person A', labelKind: 'identity', identityId: 'id-a' },
    })
    await a.settle()
    expect(a.center.groupedOpenWindows()).toHaveLength(1)
    a.setNow(T0 + 91_000)
    await persistWatermark(a)
    expect(a.center.groupedOpenWindows()).toHaveLength(1)
    expect(persistedWatermark(a.world)).toBeLessThanOrEqual(T0)

    // CRASH before the close. The stored record of the frozen event carries the
    // recognition by now: the replay reaches it only if the scan starts at or before T0.
    const recognised: ObjectEvent = {
      ...judged,
      subLabel: 'Person A',
      subLabelMeta: { stepId: 'face-recognizer', decidedAt: 1, identityId: 'id-a' },
    }
    log.events.splice(0, log.events.length, recognised)
    const b = harness({ world: a.world, startAt: T0 + 120_000, listObjectEventsSince: log.list })
    await restart(b)

    const rows = groupedRows(b)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.members).toEqual(['trk-2'])
  })

  it('MEDIUM-1 (P2): an absorbed id the alias store cannot resolve is refused after a crash — the row carries it', async () => {
    const log = eventLog()
    const a = harness({ listObjectEventsSince: log.list })
    await boot(a, rule(NO_COOLDOWN))
    const e1 = event({ trackId: 'trk-2', timestamp: T0 })
    const e2 = event({ trackId: 'trk-1', timestamp: T0 + 1_000 })
    log.events.push(e1, e2)
    a.center.onObjectEventPersisted(e1)
    a.center.onObjectEventPersisted(e2)
    await a.settle()
    a.center.onTracksFused({ deviceId: DEVICE, survivorId: 'trk-9', absorbedId: 'trk-1' })
    await a.settle()
    await a.tick(T0 + 21_000)
    expect(groupedRows(a)).toHaveLength(1)
    const group = payloads(a.world)[0]?.group
    expect(group !== undefined && isGroupV2(group) ? group.members : []).toEqual([
      expect.objectContaining({ trackId: 'trk-2' }),
      expect.objectContaining({ trackId: 'trk-9', absorbedIds: ['trk-1'] }),
    ])

    // CRASH; B has no alias store at all: trk-1 replays under its own id.
    const b = harness({ world: a.world, startAt: T0 + 40_000, listObjectEventsSince: log.list })
    await restart(b)

    expect(groupedRows(b)).toHaveLength(1)
    expect(
      b
        .linesOf('grouped window: track already notified by this rule')
        .map((l) => l.meta['trackId']),
    ).toEqual(['trk-2', 'trk-1'])
  })

  it('MEDIUM-2 (P3): a track notified 41 min ago and still in view is not re-notified after a crash', async () => {
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))
    a.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 }))
    await a.settle()
    await a.tick(T0 + 21_000)
    expect(groupedRows(a)).toHaveLength(1)
    // In view: refused (and its TTL slid) every 5 min for 40 min — never re-notified in A.
    for (let t = T0 + 5 * 60_000; t <= T0 + 40 * 60_000; t += 5 * 60_000) {
      a.setNow(t)
      a.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: t }))
      await a.settle()
    }
    expect(groupedRows(a)).toHaveLength(1)

    // CRASH at T0+41 min: the row is older than the 30-min horizon, the track is not closed.
    const b = harness({ world: a.world, startAt: T0 + 41 * 60_000 })
    await restart(b)
    b.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 + 41 * 60_000 }))
    await b.settle()
    await b.tick(T0 + 42 * 60_000)

    expect(groupedRows(b)).toHaveLength(1)
    const hydrated = b.linesOf('grouped notified tracks hydrated from the outbox')
    expect(hydrated.map((l) => [l.meta['tracks'], l.meta['carried']])).toEqual([[0, 1]])
  })

  it('MEDIUM-A: a member of an older row is carried even when a track store lists its track closed — the track store is not asked', async () => {
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))
    a.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 }))
    await a.settle()
    await a.tick(T0 + 21_000)
    expect(groupedRows(a)).toHaveLength(1)

    const asked: number[] = []
    const b = harness({
      world: a.world,
      startAt: T0 + 41 * 60_000,
      listRecentTracks: async (since) => {
        asked.push(since)
        return [track({ trackId: 'trk-1', lastSeen: T0 + 60_000 })]
      },
    })
    await restart(b)

    expect(asked).toEqual([])
    const hydrated = b.linesOf('grouped notified tracks hydrated from the outbox')
    expect(hydrated.map((l) => [l.meta['tracks'], l.meta['carried']])).toEqual([[0, 1]])
  })

  it('LOW-1: a hydration read that fails once is retried inside the outbox phase', async () => {
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))
    a.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 }))
    await a.settle()
    await a.tick(T0 + 21_000)
    await a.center.stop()

    const b = harness({ world: flakyRecentRows(a.world, 1), startAt: T0 + 60_000 })
    await restart(b)
    b.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 + 60_000 }))
    await b.settle()

    expect(
      b.linesOf(
        'grouped notified-track hydration failed — a replayed window is guarded by the dedup id only',
      ),
    ).toHaveLength(0)
    expect(b.linesOf('grouped notified tracks hydrated from the outbox')).toHaveLength(1)
    expect(
      b
        .linesOf('grouped window: track already notified by this rule')
        .map((l) => l.meta['trackId']),
    ).toEqual(['trk-1'])
  })

  it('LOW-1: a cooldown reseed whose read FAILED says so', async () => {
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))
    await a.center.stop()

    const b = harness({ world: flakyRecentRows(a.world, 3), startAt: T0 + 60_000 })
    await restart(b)

    const warned = b.linesOf(
      'cooldown reseed failed — the outbox could not be read; cooldowns start cold',
    )
    expect(warned.map((l) => l.level)).toEqual(['warn'])
  })

  it('LOW-2: a reconcile that throws mid-scan still releases the replay — the replayed window closes', async () => {
    const malformed = event({ trackId: 'trk-x', timestamp: T0 + 500 })
    Object.defineProperty(malformed, 'className', {
      get: () => {
        throw new Error('malformed event row')
      },
    })
    const replayed = [event({ trackId: 'trk-1', timestamp: T0 }), malformed]
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))

    const b = harness({
      world: a.world,
      startAt: T0 + 40_000,
      listObjectEventsSince: async () => replayed,
    })
    await restart(b)
    await b.settle()

    expect(b.linesOf('notification reconcile failed')).toHaveLength(1)
    expect(b.center.groupedOpenWindows()).toHaveLength(0)
    expect(groupedRows(b)).toEqual([
      {
        key: expect.stringContaining(`:trk-1@${String(T0)}`),
        closeReason: 'replayed',
        members: ['trk-1'],
      },
    ])
  })

  it('LOW-4: a recent-rows read that hits its limit says it may be truncated', async () => {
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))
    await a.center.stop()
    for (let i = 0; i < NC_OUTBOX_RECENT_QUERY_LIMIT; i += 1) {
      a.world.seed('outbox', { id: `junk-${String(i)}`, data: { createdAt: T0 + i } })
    }

    const b = harness({ world: a.world, startAt: T0 + 60_000 })
    await restart(b)

    const warned = b.linesOf('outbox recent query hit its limit — older rows were not read')
    expect(warned.map((l) => [l.level, l.meta['limit']])).toEqual([
      ['warn', NC_OUTBOX_RECENT_QUERY_LIMIT],
    ])
  })
})

describe('a grouped window survives a respawn — review T10 fix round 2', () => {
  const centres: Harness[] = []
  function harness(options: HarnessOptions = {}): Harness {
    const h = makeHarness(options)
    centres.push(h)
    return h
  }
  afterEach(async () => {
    for (const h of centres.splice(0)) await h.center.stop()
  })

  it('LOW-A (PC): a hydration that FAILED replays on the strict watermark — an in-slack, already-sent window is not sent again', async () => {
    const log = eventLog()
    const a = harness({ listObjectEventsSince: log.list, startAt: T0 - 10_000 })
    await boot(a, rule(NO_COOLDOWN))
    // Two subjects in one window: the replay's scan, from watermark − 60 s, misses the
    // first and sees the second — a window re-keyed under it would be a second message.
    for (const [trackId, timestamp] of [
      ['trk-1', T0],
      ['trk-2', T0 + 10_000],
    ] as const) {
      const e = event({ trackId, timestamp })
      log.events.push(e)
      a.setNow(timestamp)
      a.center.onObjectEventPersisted(e)
      await a.settle()
    }
    await a.tick(T0 + 40_000)
    expect(groupedRows(a)).toHaveLength(1)
    // The periodic write puts the watermark past the settled window.
    await a.tick(T0 + 70_000)
    await persistWatermark(a)
    expect(persistedWatermark(a.world)).toBe(T0 + 70_000)

    // CRASH; the boot's recent-rows read fails on all three attempts.
    const b = harness({
      world: flakyRecentRows(a.world, 3),
      startAt: T0 + 80_000,
      listObjectEventsSince: log.list,
    })
    await restart(b)
    await b.tick(T0 + 120_000)

    expect(groupedRows(b)).toHaveLength(1)
    const perCamera = b.linesOf('grouped replay: events older than the watermark opened no window')
    expect(perCamera.map((l) => [l.level, l.tags['deviceId'], l.meta['refused']])).toEqual([
      ['info', DEVICE, 1],
    ])
    const summary = b.linesOf('grouped replay released')
    expect(summary.map((l) => [l.meta['hydrated'], l.meta['overlapMs']])).toEqual([[false, 0]])
  })

  it('LOW-A: a hydrated boot keeps the overlap and says so', async () => {
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))
    await a.center.stop()
    const b = harness({ world: a.world, startAt: T0 + 60_000 })
    await restart(b)
    const summary = b.linesOf('grouped replay released')
    expect(summary.map((l) => [l.meta['hydrated'], l.meta['overlapMs']])).toEqual([
      [true, RECONCILE_OVERLAP_MS],
    ])
  })

  it('LOW-C: the replay overlap covers the longest grouping window (the slack is sound only then)', () => {
    expect(RECONCILE_OVERLAP_MS).toBeGreaterThanOrEqual(NC_GROUPING_MAX_SEC * 1_000)
  })

  it('LOW-D: a reconcile scan that returns its limit says it may have dropped the oldest events', async () => {
    const many = Array.from({ length: RECONCILE_SCAN_LIMIT }, (_, i) =>
      event({ trackId: `trk-${String(i)}`, timestamp: T0 + i }),
    )
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))
    const b = harness({
      world: a.world,
      startAt: T0 + 40_000,
      listObjectEventsSince: async () => many,
    })
    await restart(b)
    const warned = b.linesOf(
      'notification reconcile scan hit its limit — older missed events were not read',
    )
    expect(warned.map((l) => [l.level, l.meta['count'], l.meta['limit']])).toEqual([
      ['warn', RECONCILE_SCAN_LIMIT, RECONCILE_SCAN_LIMIT],
    ])
  })

  it('LOW-D: a scan below its limit is silent', async () => {
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))
    const b = harness({
      world: a.world,
      startAt: T0 + 40_000,
      listObjectEventsSince: async () => [event({ trackId: 'trk-1', timestamp: T0 })],
    })
    await restart(b)
    expect(
      b.linesOf('notification reconcile scan hit its limit — older missed events were not read'),
    ).toHaveLength(0)
  })

  it('nit: a reconcile that throws mid-scan counts the events it had scheduled', async () => {
    const malformed = event({ trackId: 'trk-x', timestamp: T0 + 500 })
    Object.defineProperty(malformed, 'className', {
      get: () => {
        throw new Error('malformed event row')
      },
    })
    const a = harness()
    await boot(a, rule(NO_COOLDOWN))
    const b = harness({
      world: a.world,
      startAt: T0 + 40_000,
      listObjectEventsSince: async () => [event({ trackId: 'trk-1', timestamp: T0 }), malformed],
    })
    await restart(b)
    const failed = b.linesOf('notification reconcile failed')
    expect(failed.map((l) => l.meta['scheduled'])).toEqual([1])
  })
})
