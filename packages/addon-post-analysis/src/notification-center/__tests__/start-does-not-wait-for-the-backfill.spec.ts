/**
 * THE NOTIFICATION CENTRE'S BOOT BACK-FILL MUST NOT HOLD `start()`.
 *
 * ## What this pins
 *
 * `NotificationCenter.start()` is awaited by `buildNotificationCenter`, which
 * is awaited by `pipeline-analytics.onInitialize()`, and `addon-runner`
 * publishes a child's capability manifest only AFTER `initialize()` returns.
 * Measured on the live hub 2026-08-17 at ZERO transport contention: the
 * `buildNotificationCenter` boot step took **270 s**, and every second of it
 * was durable back-fill — `hydrateLiveness` (775 subjects), `outbox.load`
 * (743 rows) and two N+1 per-device refresh loops (`readDeviceStates`,
 * `readDeviceZoneIds`: one RPC per watched device, serially). For all 270 s
 * the cluster had no provider for any capability this addon declares, and the
 * intake was not open either — nothing arriving in that window was late, it
 * was never evaluated at all.
 *
 * 2026-08-14 established the contract for the two PRODUCERS
 * (`boot-backfill-never-blocks-start.spec.ts`): *`start()` resolving means
 * "the producer is running", never "the back-fill has finished"*. This file
 * extends it to the centre itself and adds the question the producers never
 * had to answer: the outbox is a DEDUP LEDGER, so a hydration moved off the
 * critical path must lose no notification and must duplicate none.
 */
import type { InMemoryRecords, ObjectEvent } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { makeNcRecords, ncPruneWindowsPort, ncTable, withNcFaults } from './support/nc-test-deps.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CALLER = { userId: 'admin-42', isAdmin: true }
const NOW = 100_000
const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
]

/**
 * A query gate over one kind, with BOTH ends controllable:
 *
 *  - `takeSnapshot()` lets the query actually read the store (`taken` resolves
 *    once it has), and
 *  - `release()` hands the rows back to the caller.
 *
 * Two knobs rather than one because a slow store has two edges, and the bug
 * that matters lives between them: the rows a 50 s query is holding describe
 * the store as it was when the query RAN, and the centre keeps evaluating,
 * enqueueing and delivering the whole time. Only a gate that can open the
 * first edge and hold the second reproduces "a stale snapshot applied late".
 */
interface Gate {
  readonly world: InMemoryRecords
  /** Resolves once the gated query has read the store. */
  readonly taken: Promise<void>
  takeSnapshot(): void
  release(): void
}

function gateQueries(
  inner: InMemoryRecords,
  kind: string,
  opts: { readonly never?: boolean; readonly holdSnapshot?: boolean } = {},
): Gate {
  let openSnapshot = (): void => {}
  let markTaken = (): void => {}
  let openReturn = (): void => {}
  const snapshotBarrier = new Promise<void>((resolve) => {
    openSnapshot = resolve
  })
  const taken = new Promise<void>((resolve) => {
    markTaken = resolve
  })
  const returnBarrier = new Promise<void>((resolve) => {
    openReturn = resolve
  })
  if (opts.holdSnapshot !== true) openSnapshot()
  const world = withNcFaults(inner, {
    aroundQuery: async (queried, read) => {
      if (queried !== kind) return read()
      if (opts.never === true) await new Promise<void>(() => {})
      await snapshotBarrier
      const rows = await read()
      markTaken()
      await returnBarrier
      return rows
    },
  })
  return { world, taken, takeSnapshot: () => openSnapshot(), release: () => openReturn() }
}

interface Harness {
  readonly center: NotificationCenter
  readonly world: InMemoryRecords
  readonly sends: NcSendInput[]
}

function makeCenter(world: InMemoryRecords, sends: NcSendInput[]): NotificationCenter {
  return new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: ncPruneWindowsPort(),
    dispatcher: {
      listTargets: async () => TARGETS,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Driveway',
      // No media exists for these synthetic records, and the dispatcher's
      // still-rescue wait (`NC_STILL_WAIT_MS`, 3 s) is not what is under test.
      sleep: async () => undefined,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    now: () => NOW,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
}

function makeEvent(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
  return {
    id: 100_001,
    kind: 'object',
    deviceId: 104,
    timestamp: NOW,
    trackId: 'trk-1',
    className: 'person',
    confidence: 0.9,
    zones: [],
    ...overrides,
  }
}

async function createPersonRule(center: NotificationCenter): Promise<void> {
  await center.buildProvider().createRule({
    rule: NcRuleInputSchema.parse({
      name: 'person rule',
      delivery: 'immediate',
      targets: [{ targetId: 'tgt-1' }],
      conditions: { classes: ['person'] },
    }),
    caller: CALLER,
  })
}

/** `start()` must resolve; anything else is the bug. Bounded so a regression
 *  fails as a timeout on THIS assertion rather than on the whole file. */
async function withinBound(started: Promise<void>): Promise<void> {
  await Promise.race([
    started,
    new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error('start() did not resolve — the boot back-fill is being awaited')),
        2_000,
      )
      t.unref?.()
    }),
  ])
}

function outboxIds(world: InMemoryRecords): string[] {
  return [...ncTable(world, 'outbox').keys()]
}

function outboxStatus(world: InMemoryRecords, id: string): unknown {
  return ncTable(world, 'outbox').get(id)?.['status']
}

const centres: NotificationCenter[] = []

function track(center: NotificationCenter): NotificationCenter {
  centres.push(center)
  return center
}

afterEach(async () => {
  for (const c of centres) await c.stop()
  centres.length = 0
})

describe('NotificationCenter.start — the back-fill is armed, never awaited', () => {
  async function bootWithHangingCollection(collection: string): Promise<Harness> {
    const world = makeNcRecords()
    const sends: NcSendInput[] = []
    const gated = gateQueries(world, collection, { never: true })
    const center = track(makeCenter(gated.world, sends))
    await withinBound(center.start({ evaluation: true }))
    return { center, world, sends }
  }

  it('resolves and EVALUATES while the outbox hydration is still in flight', async () => {
    const world = makeNcRecords()
    const sends: NcSendInput[] = []
    const gated = gateQueries(world, 'outbox', { never: true })
    const center = track(makeCenter(gated.world, sends))

    await withinBound(center.start({ evaluation: true }))

    // …and it really is running, or "does not block" would be satisfied by a
    // centre that simply never opened its intake.
    await createPersonRule(center)
    center.onObjectEventPersisted(makeEvent())
    await vi.waitFor(() => {
      expect(outboxIds(world)).toHaveLength(1)
    })
    await center.drainNow()
    expect(sends).toHaveLength(1)
  })

  it('resolves while the liveness ledger reseed is still in flight', async () => {
    const h = await bootWithHangingCollection('liveness')
    await createPersonRule(h.center)
    h.center.onObjectEventPersisted(makeEvent())
    await vi.waitFor(() => {
      expect(outboxIds(h.world)).toHaveLength(1)
    })
    await h.center.drainNow()
    expect(h.sends).toHaveLength(1)
  })
})

describe('NotificationCenter.start — a cold dedup horizon never duplicates', () => {
  it('does not resurrect a row that was already DELIVERED before the restart', async () => {
    // The previous process's work: the rule fired for this track and the row is
    // terminal. The dedup id is `(ruleId, dedupRef, targetId)`, so the restarted
    // centre computes the very same id for the very same event.
    const world = makeNcRecords()
    const firstSends: NcSendInput[] = []
    const first = track(makeCenter(world, firstSends))
    await first.start({ evaluation: true })
    await createPersonRule(first)
    first.onObjectEventPersisted(makeEvent())
    await vi.waitFor(() => {
      expect(outboxIds(world)).toHaveLength(1)
    })
    await first.drainNow()
    const id = outboxIds(world)[0]!
    expect(outboxStatus(world, id)).toBe('sent')
    expect(firstSends).toHaveLength(1)
    await first.stop()

    // The restart: same durable store, an outbox load that has not landed.
    const gated = gateQueries(world, 'outbox')
    const sends: NcSendInput[] = []
    const center = track(makeCenter(gated.world, sends))
    await withinBound(center.start({ evaluation: true }))

    // The very same event arrives again while the horizon is COLD.
    center.onObjectEventPersisted(makeEvent())
    await vi.waitFor(() => {
      expect(outboxStatus(world, id)).toBe('sent')
    })
    await center.drainNow()

    // The terminal row is untouched and nothing went out a second time.
    expect(outboxIds(world)).toHaveLength(1)
    expect(outboxStatus(world, id)).toBe('sent')
    expect(sends).toHaveLength(0)
    gated.release()
  })

  it('a load that lands with a STALE snapshot never re-queues a delivered row', async () => {
    const world = makeNcRecords()
    // The snapshot is held back until the row EXISTS and is `pending` — that
    // is the only arrangement in which the load has something to resurrect.
    const gated = gateQueries(world, 'outbox', { holdSnapshot: true })
    const sends: NcSendInput[] = []
    const center = track(makeCenter(gated.world, sends))
    await withinBound(center.start({ evaluation: true }))
    await createPersonRule(center)

    center.onObjectEventPersisted(makeEvent())
    await vi.waitFor(() => {
      expect(outboxIds(world)).toHaveLength(1)
    })
    const id = outboxIds(world)[0]!
    expect(outboxStatus(world, id)).toBe('pending')

    // The 50 s query reads the store HERE: one pending row.
    gated.takeSnapshot()
    await gated.taken

    // …and while it is still holding those rows, the drain delivers it.
    await center.drainNow()
    expect(sends).toHaveLength(1)
    expect(outboxStatus(world, id)).toBe('sent')

    // Now the load lands and applies what it read a moment ago.
    gated.release()
    await center.whenHydrated()
    await center.drainNow()

    // Exactly once. A second send here is the row resurrected from a snapshot
    // this process had already moved past.
    expect(sends).toHaveLength(1)
    expect(outboxStatus(world, id)).toBe('sent')
  })

  it('loses nothing enqueued while the horizon was cold', async () => {
    const world = makeNcRecords()
    const gated = gateQueries(world, 'outbox')
    const sends: NcSendInput[] = []
    const center = track(makeCenter(gated.world, sends))
    await withinBound(center.start({ evaluation: true }))
    await createPersonRule(center)

    center.onObjectEventPersisted(makeEvent())
    await vi.waitFor(() => {
      expect(outboxIds(world)).toHaveLength(1)
    })

    gated.release()
    await center.whenHydrated()
    await center.drainNow()

    expect(sends).toHaveLength(1)
    expect(outboxStatus(world, outboxIds(world)[0]!)).toBe('sent')
  })
})
