/**
 * Spec §6.2: the order of one fusion, what happens when a row is missing, and
 * the sweep-up that catches writes landing under an absorbed id after it.
 *
 * Disarms (each alone, restored):
 *  - move the row check after `residents.adopt` (the pre-review order):
 *    "an inactive survivor refuses the fusion before any step" fails;
 *  - emit the lifecycle `end` also when the absorbed piece had no row:
 *    "an absorbed piece with no row is merged in RAM, with no lifecycle end" fails;
 *  - drop `liveState.forget` from `fuse`: "runs the steps in the spec's order" fails;
 *  - make `sweepUp` a no-op: "sweepUp re-points what landed under an absorbed id" fails;
 *  - in `TrackStore`, stop noting members closed with their survivor:
 *    "closing the survivor closes its absorbed ids to late writers" fails;
 *  - drop the `onRefused` call (review 2 M6): "a refused fusion tells the tracker" fails;
 *  - pass `keepMediaIds` as undefined from `sweepUp` (review 2 M2): "sweepUp pins the survivor's current best shot" fails;
 *  - drop the `beforePersist` hook from `expireStale` (review 2 L7): "the sweep-up runs before the row is persisted" fails;
 *  - (T16 S2) drop the refusal sampler: "refusals are sampled per camera" fails;
 *  - (absorbed row closed) treat a closed absorbed row as "no row":
 *    "a closed absorbed row refuses the fusion and keeps the chain" fails;
 *  - (carry 7/10) put an `await` before the RAM steps in `fuse`:
 *    "every RAM step has run when `fuse` returns" fails;
 *  - (carry 2) drop `kept` from the INFO line: "the INFO line carries the
 *    leaf report, kept included" fails;
 *  - (carry 5) ignore `trackStore.adopt`'s `false`: "a row merge the store
 *    refuses is said" fails;
 *  - (sweep ranking) rank every member `absorbed` in `sweepUp` instead of
 *    asking the current holder: "sweepUp ranks by the CURRENT best-shot
 *    holder" fails;
 *  - (alias isolation) let an alias failure abort the leaves: "an alias write
 *    that fails still re-points the leaves" fails;
 *  - (closing rows) drop `'closing'` from the survivor refusal: "a survivor
 *    mid-close … is refused like a closed one" fails; in `TrackStore.rowState`
 *    call every RAM entry `active`: "rowState tells an active row from one
 *    being persisted…" fails;
 *  - (chains) drop the absorbed piece's own members from
 *    `TrackStore.noteMember`: "a chained fusion closes the absorbed piece's
 *    own members too" fails;
 *  - (fix round 1 M2) skip `noteMember` for a row-less absorbed piece in
 *    `fuse`: "an absorbed piece with no row is swept up at its survivor's
 *    close…" fails; read nothing in `sweepUp` from `membersOf`: "sweepUp
 *    re-points…" fails; in `TrackStore.clearDevice` keep row-less survivors'
 *    membership: "an operator delete closes the members…" fails;
 *  - (fix round 1 M3) await the queue unbounded in `sweepUp`: "a survivor
 *    close waits at most SWEEP_UP_WAIT_MS…" fails;
 *  - (fix round 1 L3) let a RAM step's throw escape: "a RAM step that throws
 *    is said…" fails;
 *  - (hook isolation) drop the try/catch around `beforePersist`: "a sweep-up
 *    that throws never keeps the row from persisting" fails.
 *
 * Deviations from the brief, on purpose: the service reads ONE row state
 * (`TrackStore.rowState`: active | closing | closed | none) instead of
 * `hasActive`, because "no row" and "closed" call for different outcomes (a
 * deferred birth is merged in RAM, a closed row is refused), and a row being
 * persisted is neither active nor closed. There is no alias-ledger fallback in
 * `sweepUp`: an active row is RAM only, so every survivor that can close was
 * fused by this process.
 */
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TrackFusionLeafCount } from '../pipeline/track-fusion-leaf.js'
import {
  SWEEP_UP_WAIT_MS,
  TrackFusionService,
  type TrackFusionServiceDeps,
} from '../pipeline/track-fusion-service.js'
import type { TrackFusion } from '../pipeline/tracker-v2/index.js'
import { buildTrackStoreForTest, sighting } from './track-store-test-helpers.js'

const FUSION: TrackFusion = {
  survivorId: 'A',
  absorbedId: 'B',
  members: ['B'],
  t: 11_000,
  cost: 0.4,
  gapMs: 5000,
}

interface DepsOptions {
  readonly active?: ReadonlySet<string>
  readonly closed?: ReadonlySet<string>
  /** Rows `expireStale` is persisting right now (`active: false`, still held). */
  readonly closing?: ReadonlySet<string>
  readonly holder?: string
  readonly rowAdopt?: boolean
  readonly counts?: readonly TrackFusionLeafCount[]
  readonly aliasFails?: boolean
  readonly fields?: (LogExtras | undefined)[]
  readonly now?: () => number
  /** Leaves for this camera never settle (a hung vector store, review M3). */
  readonly hangDevice?: number
  /** This RAM step throws (review L3). */
  readonly throwIn?: 'plate'
  /** D692: records `lifecycle.fused` calls apart from `calls`, so the step-order
   *  assertions above stay exactly as they were. */
  readonly fused?: string[]
}

/** Records info/warn as `log:` / `warn:` calls (and their fields); the rest is silent. */
function recordingLogger(calls: string[], fields?: (LogExtras | undefined)[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (m, f) => {
      calls.push(`log:${m}`)
      fields?.push(f)
    },
    warn: (m, f) => {
      calls.push(`warn:${m}`)
      fields?.push(f)
    },
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function deps(calls: string[], opts: DepsOptions = {}): TrackFusionServiceDeps {
  const active = opts.active ?? new Set(['A', 'B'])
  const closed = opts.closed ?? new Set<string>()
  const closing = opts.closing ?? new Set<string>()
  // The store's membership registry, as `TrackStore.noteMember` keeps it.
  const members = new Map<string, readonly string[]>()
  const noteMember = (survivorId: string, absorbedId: string): void => {
    members.set(survivorId, [
      ...(members.get(survivorId) ?? []),
      absorbedId,
      ...(members.get(absorbedId) ?? []),
    ])
    members.delete(absorbedId)
  }
  return {
    logger: recordingLogger(calls, opts.fields),
    residents: {
      adopt: () => {
        calls.push('residents')
        return { bestShotFrom: 'absorbed' }
      },
      bestShotMediaIds: () => new Set([42]),
      bestShotHolder: () => opts.holder ?? 'B',
    },
    onRefused: (_d, _k, f) => calls.push(`refused:${f.survivorId}`),
    recognizers: {
      adoptFace: () => calls.push('face'),
      adoptPlate: () => {
        if (opts.throwIn === 'plate') throw new Error('plate state gone')
        calls.push('plate')
      },
    },
    liveState: { forget: () => calls.push('live') },
    lifecycle: {
      emitFusedEnd: () => calls.push('lifecycle'),
      fused: (_d, survivorId, absorbedId) => opts.fused?.push(`${survivorId}<-${absorbedId}`),
    },
    trackStore: {
      rowState: (id) =>
        active.has(id)
          ? 'active'
          : closing.has(id)
            ? 'closing'
            : closed.has(id)
              ? 'closed'
              : 'none',
      adopt: (survivorId, absorbedId) => {
        calls.push('row')
        if (opts.rowAdopt === false) return false
        noteMember(survivorId, absorbedId)
        return true
      },
      noteMember: (_d, survivorId, absorbedId) => {
        calls.push('member')
        noteMember(survivorId, absorbedId)
      },
      membersOf: (survivorId) => members.get(survivorId) ?? [],
    },
    aliases: {
      record: async () => {
        calls.push('alias')
        if (opts.aliasFails === true) throw new Error('alias store down')
      },
    },
    leaves: () => [
      {
        reassignTrack: async (req) => {
          if (req.deviceId === opts.hangDevice) await new Promise<void>(() => {})
          calls.push(
            `leaves:${req.absorbedId}->${req.survivorId}:${req.bestShotFrom}${req.keepMediaIds !== undefined ? `:keep${[...req.keepMediaIds].join(',')}` : ''}`,
          )
          return opts.counts ?? [{ family: 'events', moved: 1, dropped: 0 }]
        },
      },
    ],
    media: {
      moveOwner: async () => 0,
      deleteOwner: async () => 0,
      stillPresent: async () => true,
    },
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  }
}

describe('TrackFusionService', () => {
  it("runs the steps in the spec's order", async () => {
    const calls: string[] = []
    const svc = new TrackFusionService(deps(calls))
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    expect(calls).toEqual([
      'residents',
      'face',
      'plate',
      'live',
      'lifecycle',
      'row',
      'alias',
      'leaves:B->A:absorbed',
      'log:track fused',
    ])
  })

  it('every RAM step has run when `fuse` returns, before its promise is awaited (carry 7/10)', () => {
    const calls: string[] = []
    const svc = new TrackFusionService(deps(calls))
    void svc.fuse(101, '101:pipeline', FUSION)
    // Nothing awaited: the frame that surfaced the fusion upserts onto the
    // survivor right after this call, so the RAM merge must already be done.
    expect(calls).toEqual(['residents', 'face', 'plate', 'live', 'lifecycle', 'row'])
  })

  it('an inactive survivor refuses the fusion before any step, and a refused fusion tells the tracker (review 2 M6)', async () => {
    const calls: string[] = []
    const svc = new TrackFusionService(deps(calls, { active: new Set(['B']) }))
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    expect(calls.filter((c) => !c.startsWith('warn:'))).toEqual(['refused:A'])
    expect(calls.some((c) => c.startsWith('warn:track fusion refused'))).toBe(true)
  })

  it('a CLOSED survivor is refused with its reason, tagged with the camera (T16 S2)', async () => {
    const calls: string[] = []
    const fields: (LogExtras | undefined)[] = []
    const svc = new TrackFusionService(
      deps(calls, { active: new Set(['B']), closed: new Set(['A']), fields }),
    )
    await svc.fuse(101, '101:pipeline', FUSION)
    expect(calls.filter((c) => !c.startsWith('warn:'))).toEqual(['refused:A'])
    expect(fields[0]).toMatchObject({
      tags: { deviceId: 101 },
      meta: { reason: 'survivor-closed', survivorId: 'A', absorbedId: 'B' },
    })
  })

  it('a survivor mid-close (its row is being persisted) is refused like a closed one', async () => {
    const calls: string[] = []
    const fields: (LogExtras | undefined)[] = []
    const svc = new TrackFusionService(
      deps(calls, { active: new Set(['B']), closing: new Set(['A']), fields }),
    )
    await svc.fuse(101, '101:pipeline', FUSION)
    expect(calls.filter((c) => !c.startsWith('warn:'))).toEqual(['refused:A'])
    expect(fields[0]?.meta).toMatchObject({ reason: 'survivor-closed' })
  })

  it('refusals are sampled per camera, with the suppressed count on the next line (T16 S2)', async () => {
    const calls: string[] = []
    const fields: (LogExtras | undefined)[] = []
    let now = 1_000
    const svc = new TrackFusionService(
      deps(calls, { active: new Set(['B']), fields, now: () => now }),
    )
    for (let i = 0; i < 5; i += 1) await svc.fuse(101, '101:pipeline', FUSION)
    expect(calls.filter((c) => c.startsWith('warn:'))).toHaveLength(1)
    expect(calls.filter((c) => c.startsWith('refused:'))).toHaveLength(5)
    // Another camera is its own window.
    await svc.fuse(616, '616:pipeline', FUSION)
    expect(calls.filter((c) => c.startsWith('warn:'))).toHaveLength(2)
    now += 60_001
    await svc.fuse(101, '101:pipeline', FUSION)
    expect(calls.filter((c) => c.startsWith('warn:'))).toHaveLength(3)
    expect(fields.at(-1)?.meta).toMatchObject({ suppressed: 4 })
  })

  it('a closed absorbed row refuses the fusion and keeps the chain — a fusion never touches a closed track', async () => {
    const calls: string[] = []
    const fields: (LogExtras | undefined)[] = []
    const svc = new TrackFusionService(
      deps(calls, { active: new Set(['A']), closed: new Set(['B']), fields }),
    )
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    expect(calls.filter((c) => !c.startsWith('warn:'))).toEqual([])
    expect(fields[0]?.meta).toMatchObject({ reason: 'absorbed-closed' })
  })

  it('an absorbed piece with no row is merged in RAM, with no lifecycle end and no warning', async () => {
    const calls: string[] = []
    const svc = new TrackFusionService(deps(calls, { active: new Set(['A']) }))
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    expect(calls).toEqual([
      'residents',
      'face',
      'plate',
      'live',
      'member',
      'alias',
      'leaves:B->A:absorbed',
      'log:track fused',
    ])
  })

  it('two pieces neither of which has a row yet merge in RAM only — the chain is not dropped', async () => {
    const calls: string[] = []
    const svc = new TrackFusionService(deps(calls, { active: new Set() }))
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    expect(calls).toEqual([
      'residents',
      'face',
      'plate',
      'live',
      'member',
      'alias',
      'leaves:B->A:absorbed',
      'log:track fused',
    ])
  })

  it('the INFO line carries the leaf report, kept included (carry 2, 12)', async () => {
    const calls: string[] = []
    const fields: (LogExtras | undefined)[] = []
    const svc = new TrackFusionService(
      deps(calls, {
        fields,
        counts: [
          { family: 'media', moved: 2, dropped: 1, kept: 1 },
          { family: 'faces', moved: 0, dropped: 0, kept: 1 },
        ],
      }),
    )
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    expect(fields.at(-1)).toMatchObject({
      tags: { deviceId: 101 },
      meta: {
        survivorId: 'A',
        absorbedId: 'B',
        moved: 2,
        dropped: 1,
        kept: 2,
        counts: [
          { family: 'media', moved: 2, dropped: 1, kept: 1 },
          { family: 'faces', moved: 0, dropped: 0, kept: 1 },
        ],
      },
    })
  })

  it('a row merge the store refuses is said (carry 5)', async () => {
    const calls: string[] = []
    const svc = new TrackFusionService(deps(calls, { rowAdopt: false }))
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    expect(calls).toContain('warn:track fusion: the row merge was refused by the store')
  })

  it('an alias write that fails still re-points the leaves, and the INFO line says so', async () => {
    const calls: string[] = []
    const fields: (LogExtras | undefined)[] = []
    const svc = new TrackFusionService(deps(calls, { aliasFails: true, fields }))
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    expect(calls).toContain('leaves:B->A:absorbed')
    expect(fields.at(-1)?.meta).toMatchObject({ aliasError: 'Error: alias store down' })
  })

  it("sweepUp re-points what landed under an absorbed id, and pins the survivor's current best shot (review 2 M2)", async () => {
    const calls: string[] = []
    const svc = new TrackFusionService(deps(calls))
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    calls.length = 0
    await svc.sweepUp(101, 'A')
    expect(calls).toEqual(['leaves:B->A:absorbed:keep42', 'log:track fusion swept up'])
  })

  it('sweepUp ranks by the CURRENT best-shot holder, not the fusion-time verdict', async () => {
    const calls: string[] = []
    // The fusion chose the absorbed shot; the survivor has since taken a
    // better one of its own, so the holder is the survivor again.
    const svc = new TrackFusionService(deps(calls, { holder: 'A' }))
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    calls.length = 0
    await svc.sweepUp(101, 'A')
    expect(calls).toEqual(['leaves:B->A:survivor:keep42', 'log:track fusion swept up'])
  })

  it('sweepUp of a survivor that absorbed nothing does no work', async () => {
    const calls: string[] = []
    const svc = new TrackFusionService(deps(calls))
    await svc.sweepUp(101, 'A')
    expect(calls).toEqual([])
  })

  it("a chained fusion hands the absorbed piece's own members to the survivor", async () => {
    const calls: string[] = []
    const svc = new TrackFusionService(deps(calls, { active: new Set(['A', 'B', 'C']) }))
    await svc.fuse(101, 'k', { ...FUSION, survivorId: 'B', absorbedId: 'C', members: ['C'] })
    await svc.fuse(101, 'k', FUSION)
    await svc.settled(101)
    calls.length = 0
    await svc.sweepUp(101, 'A')
    expect(calls.filter((c) => c.startsWith('leaves:'))).toEqual([
      'leaves:B->A:absorbed:keep42',
      'leaves:C->A:survivor:keep42',
    ])
  })
})

describe('TrackFusionService — fix round 1', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a survivor close waits at most SWEEP_UP_WAIT_MS for a hung re-point, then says so (review M3)', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const fields: (LogExtras | undefined)[] = []
    const svc = new TrackFusionService(deps(calls, { hangDevice: 101, fields }))
    await svc.fuse(101, '101:pipeline', FUSION)
    let done = false
    const closing = svc.sweepUp(101, 'A').then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(SWEEP_UP_WAIT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await closing
    expect(done).toBe(true)
    expect(calls).toContain(
      'warn:track fusion sweep-up still running — the survivor closes without waiting for it',
    )
    expect(fields.at(-1)).toMatchObject({
      tags: { deviceId: 101 },
      meta: { survivorId: 'A', members: ['B'] },
    })
  })

  it("a hung camera never holds another camera's close (review M3)", async () => {
    const calls: string[] = []
    const svc = new TrackFusionService(
      deps(calls, { hangDevice: 101, active: new Set(['A', 'B', 'X', 'Y']) }),
    )
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.fuse(616, '616:pipeline', { ...FUSION, survivorId: 'X', absorbedId: 'Y' })
    // Real timers: this resolves on 616's own queue, not after 101's bound.
    await svc.sweepUp(616, 'X')
    expect(calls).toContain('log:track fusion swept up')
    expect(calls.some((c) => c.startsWith('warn:'))).toBe(false)
  })

  it('a RAM step that throws is said, and the row merge and the re-point still run (review L3)', async () => {
    const calls: string[] = []
    const svc = new TrackFusionService(deps(calls, { throwIn: 'plate' }))
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    expect(calls).toEqual([
      'residents',
      'face',
      'warn:track fusion: a RAM step failed — the fusion continues',
      'live',
      'lifecycle',
      'row',
      'alias',
      'leaves:B->A:absorbed',
      'log:track fused',
    ])
  })

  it("an absorbed piece with no row is swept up at its survivor's close, from the store's registry (review M2)", async () => {
    const calls: string[] = []
    const svc = new TrackFusionService(deps(calls, { active: new Set(['A']) }))
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    calls.length = 0
    await svc.sweepUp(101, 'A')
    expect(calls).toEqual(['leaves:B->A:absorbed:keep42', 'log:track fusion swept up'])
  })
})

describe('TrackStore — the one membership registry (fix round 1 M2, L1)', () => {
  it('a member with no row closes to late writers with its survivor', async () => {
    const store = buildTrackStoreForTest({ ttlMs: 1000 })
    store.upsert(sighting('A', 1000, 100))
    store.noteMember(1, 'A', 'B')
    expect(store.membersOf('A')).toEqual(['B'])
    await store.expireStale(60_000)
    expect(store.rowClosedAt('B')).toBeDefined()
    expect(store.membersOf('A')).toEqual([])
  })

  it('a DISCARDED survivor closes its members and forgets them', async () => {
    const store = buildTrackStoreForTest({ ttlMs: 1000 })
    store.upsert({ ...sighting('A', 1000, 100), className: 'car' })
    store.noteMember(1, 'A', 'B')
    const discarded: string[] = []
    await store.expireStale(60_000, { onDiscard: (t) => discarded.push(t.trackId) })
    expect(discarded).toEqual(['A'])
    expect(store.rowClosedAt('B')).toBeDefined()
    expect(store.membersOf('A')).toEqual([])
  })

  it('an operator delete closes the members; a promotion drop and a device clear forget them', async () => {
    const deleted = buildTrackStoreForTest({ ttlMs: 1000 })
    deleted.upsert(sighting('A', 1000, 100))
    deleted.noteMember(1, 'A', 'B')
    await deleted.deletePersisted('A')
    expect(deleted.rowClosedAt('B')).toBeDefined()
    expect(deleted.membersOf('A')).toEqual([])

    const dropped = buildTrackStoreForTest({ ttlMs: 1000 })
    dropped.upsert(sighting('A', 1000, 100))
    dropped.noteMember(1, 'A', 'B')
    dropped.dropActive('A')
    expect(dropped.membersOf('A')).toEqual([])

    // A survivor with no row of its own is still cleared with its camera.
    const cleared = buildTrackStoreForTest({ ttlMs: 1000 })
    cleared.noteMember(1, 'A', 'B')
    cleared.noteMember(2, 'X', 'Y')
    cleared.clearDevice(1)
    expect(cleared.membersOf('A')).toEqual([])
    expect(cleared.membersOf('X')).toEqual(['Y'])
  })

  it('membership is bounded for survivors that never close', () => {
    const store = buildTrackStoreForTest({ ttlMs: 1000, closedRowMemory: 2 })
    store.noteMember(1, 'A', 'a')
    store.noteMember(1, 'B', 'b')
    store.noteMember(1, 'C', 'c')
    expect(store.membersOf('A')).toEqual([])
    expect(store.membersOf('C')).toEqual(['c'])
  })
})

describe('TrackStore close hooks', () => {
  it('the sweep-up runs before the row is persisted (review 2 L7)', async () => {
    const order: string[] = []
    const store = buildTrackStoreForTest({
      ttlMs: 1000,
      onPersist: (id) => order.push(`persist:${id}`),
    })
    store.upsert(sighting('A', 1000, 100))
    await store.expireStale(60_000, {
      beforePersist: async (t) => void order.push(`sweepUp:${t.trackId}`),
    })
    expect(order).toEqual(['sweepUp:A', 'persist:A'])
  })

  it('a sweep-up that throws never keeps the row from persisting', async () => {
    const order: string[] = []
    const store = buildTrackStoreForTest({
      ttlMs: 1000,
      onPersist: (id) => order.push(`persist:${id}`),
    })
    store.upsert(sighting('A', 1000, 100))
    await store.expireStale(60_000, {
      beforePersist: async () => {
        throw new Error('boom')
      },
    })
    expect(order).toEqual(['persist:A'])
  })
})

describe('TrackStore members of a fused row', () => {
  it('rowState tells an active row from one being persisted, a closed one and an unknown id', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const store = buildTrackStoreForTest({ ttlMs: 1000 })
    store.upsert(sighting('A', 1000, 100))
    expect(store.rowState('A')).toBe('active')
    expect(store.rowState('Z')).toBe('none')
    // Held inside the pre-persist hook: `expireStale` has set `active: false`
    // and the row is still in RAM — no fusion may touch it now.
    const expiring = store.expireStale(60_000, { beforePersist: () => gate })
    expect(store.rowState('A')).toBe('closing')
    release?.()
    await expiring
    expect(store.rowState('A')).toBe('closed')
  })

  it('closing the survivor closes its absorbed ids to late writers', async () => {
    const store = buildTrackStoreForTest({ ttlMs: 1000 })
    store.upsert(sighting('A', 1000, 100))
    store.upsert(sighting('B', 7000, 130))
    expect(store.adopt('A', 'B')).toBe(true)
    expect(store.rowClosedAt('B')).toBeUndefined()
    await store.expireStale(60_000)
    expect(store.rowClosedAt('B')).toBeDefined()
  })

  it("a chained fusion closes the absorbed piece's own members too", async () => {
    const store = buildTrackStoreForTest({ ttlMs: 1000 })
    store.upsert(sighting('A', 1000, 100))
    store.upsert(sighting('B', 7000, 130))
    store.upsert(sighting('C', 9000, 150))
    expect(store.adopt('B', 'C')).toBe(true)
    expect(store.adopt('A', 'B')).toBe(true)
    await store.expireStale(60_000)
    expect(store.rowClosedAt('C')).toBeDefined()
  })
})

describe('TrackFusionService → the notification centre (D692)', () => {
  it('a fusion WITH a row merge reaches lifecycle.fused once', async () => {
    const calls: string[] = []
    const fused: string[] = []
    const svc = new TrackFusionService(deps(calls, { fused }))
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    expect(calls).toContain('row')
    expect(fused).toEqual(['A<-B'])
  })
  it('a fusion whose absorbed piece had NO row reaches it too', async () => {
    const calls: string[] = []
    const fused: string[] = []
    const svc = new TrackFusionService(deps(calls, { active: new Set(['A']), fused }))
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    expect(calls).not.toContain('row')
    expect(fused).toEqual(['A<-B'])
  })
  it('a REFUSED fusion never reaches it', async () => {
    const calls: string[] = []
    const fused: string[] = []
    const svc = new TrackFusionService(
      deps(calls, { active: new Set(['A']), closed: new Set(['B']), fused }),
    )
    await svc.fuse(101, '101:pipeline', FUSION)
    await svc.settled(101)
    expect(fused).toEqual([])
  })
})
