/**
 * The fan-out counters the cluster has always kept and never read.
 *
 * The fixtures are the live 2026-08-29 shape: ~38 connected runners, one peer
 * carrying 78–82% of the outbound bytes, an idle addon still costing ~82
 * messages/s. Both planes always filter (the fan-out mode switches were removed
 * on 2026-10-06), so a suppressed count is what WAS dropped.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  type ChildFanoutRegistry,
  type ChildFanoutSample,
  createEventPlaneMeter,
  createEventPlaneReader,
  diffEventPlane,
  EMPTY_EVENT_PLANE_BASELINE,
  EVENT_PLANE_TOP_N,
  type EventPlaneBaseline,
  type EventPlaneCounters,
  formatEventPlane,
} from '../event-plane-report.js'
import {
  HEAP_WATCH_INTERVAL_MS,
  type LoopDelayMeter,
  startHeapWatch,
  ZERO_LOOP_DELAY,
} from '../heap-watch.js'

function counters(over: Partial<EventPlaneCounters> = {}): EventPlaneCounters {
  return {
    children: [],
    childrenConnected: 0,
    childrenUndeclared: 0,
    crossNodeDelivered: 0,
    crossNodeSuppressed: 0,
    categories: [],
    categoryOverflow: 0,
    ...over,
  }
}

function baselineOf(children: readonly ChildFanoutSample[]): EventPlaneBaseline {
  return {
    children: new Map(children.map((c) => [c.childId, c])),
    categories: new Map(),
    crossNodeDelivered: 0,
    crossNodeSuppressed: 0,
    categoryOverflow: 0,
  }
}

/** The measured 2026-08-29 shape, one minute of it. */
const LIVE_CHILDREN: readonly ChildFanoutSample[] = [
  { childId: 'pipeline-analytics', sent: 347_640, suppressed: 0 },
  { childId: 'pipeline-orchestrator', sent: 134_880, suppressed: 0 },
  { childId: 'provider-reolink', sent: 114_360, suppressed: 0 },
  { childId: 'provider-hikvision', sent: 99_540, suppressed: 0 },
  { childId: 'audio-analyzer', sent: 55_680, suppressed: 0 },
  { childId: 'ml', sent: 4_920, suppressed: 0 },
  { childId: 'decoder-ffmpeg', sent: 3_100, suppressed: 0 },
]

describe('the window is a RATE, not a total since boot', () => {
  it('reports the delta between two readings', () => {
    const before: readonly ChildFanoutSample[] = [
      { childId: 'a', sent: 1000, suppressed: 10 },
      { childId: 'b', sent: 50, suppressed: 0 },
    ]
    const w = diffEventPlane(
      baselineOf(before),
      counters({
        children: [
          { childId: 'a', sent: 1400, suppressed: 12 },
          { childId: 'b', sent: 50, suppressed: 0 },
        ],
        childrenConnected: 2,
        crossNodeDelivered: 300,
        crossNodeSuppressed: 7,
      }),
    )
    expect(w.fanoutSent).toBe(400)
    expect(w.fanoutSuppressed).toBe(2)
    expect(w.crossNodeDelivered).toBe(300)
    expect(w.crossNodeSuppressed).toBe(7)
    // `b` did not move, so it is not in the ranked list — a ranked list of
    // nothing is noise.
    expect(w.top.map((d) => d.childId)).toEqual(['a'])
  })

  it('a first reading is the whole counter, because the baseline is zero', () => {
    const w = diffEventPlane(
      EMPTY_EVENT_PLANE_BASELINE,
      counters({ children: LIVE_CHILDREN, childrenConnected: 38 }),
    )
    expect(w.fanoutSent).toBe(760_120)
  })

  it('a RESTARTED child reports a quiet window, never a negative rate', () => {
    // The registry keys by childId and a respawned runner reconnects under the
    // same id with fresh counters. A negative number on a rate reads as a broken
    // meter; "the window's traffic is unknown" is the honest report.
    const w = diffEventPlane(
      baselineOf([{ childId: 'recorder', sent: 900_000, suppressed: 4 }]),
      counters({ children: [{ childId: 'recorder', sent: 12, suppressed: 0 }] }),
    )
    expect(w.fanoutSent).toBe(0)
    expect(w.fanoutSuppressed).toBe(0)
  })

  it('names the dominant peer, largest first, and stops at five', () => {
    const w = diffEventPlane(
      EMPTY_EVENT_PLANE_BASELINE,
      counters({ children: LIVE_CHILDREN, childrenConnected: 38 }),
    )
    expect(w.top).toHaveLength(EVENT_PLANE_TOP_N)
    expect(w.top.map((d) => d.childId)).toEqual([
      'pipeline-analytics',
      'pipeline-orchestrator',
      'provider-reolink',
      'provider-hikvision',
      'audio-analyzer',
    ])
  })

  it('the meter advances its baseline, so two reads of a still plane are 0', () => {
    let current = counters({ children: LIVE_CHILDREN, childrenConnected: 38 })
    const meter = createEventPlaneMeter(() => current)
    expect(meter.read()?.fanoutSent).toBe(760_120)
    expect(meter.read()?.fanoutSent).toBe(0)
    current = counters({
      children: LIVE_CHILDREN.map((c) => ({ ...c, sent: c.sent + 100 })),
      childrenConnected: 38,
    })
    expect(meter.read()?.fanoutSent).toBe(700)
  })
})

describe('the line', () => {
  it('carries the cross-node counts, and no regime — there is only one', () => {
    const line = formatEventPlane(
      diffEventPlane(
        EMPTY_EVENT_PLANE_BASELINE,
        counters({
          children: LIVE_CHILDREN,
          childrenConnected: 38,
          crossNodeDelivered: 412,
          crossNodeSuppressed: 88,
        }),
      ),
    )
    expect(line).not.toContain('fanoutMode=')
    expect(line).toContain('crossNodeDelivered=412')
    expect(line).toContain('crossNodeSuppressed=88')
  })

  it('reports the fail-open EVEN AT ZERO — one undeclared child disables both gates', () => {
    const quiet = formatEventPlane(
      diffEventPlane(EMPTY_EVENT_PLANE_BASELINE, counters({ childrenConnected: 38 })),
    )
    expect(quiet).toContain('children=38 childrenUndeclared=0')
    const legacy = formatEventPlane(
      diffEventPlane(
        EMPTY_EVENT_PLANE_BASELINE,
        counters({ childrenConnected: 38, childrenUndeclared: 1 }),
      ),
    )
    expect(legacy).toContain('childrenUndeclared=1')
  })

  it('is a single comma-separated value, so the FIELD COUNT never changes', () => {
    const line = formatEventPlane(
      diffEventPlane(
        EMPTY_EVENT_PLANE_BASELINE,
        counters({ children: LIVE_CHILDREN, childrenConnected: 38 }),
      ),
    )
    expect(line).toContain(
      'fanoutTop=pipeline-analytics:347640/0,pipeline-orchestrator:134880/0,' +
        'provider-reolink:114360/0,provider-hikvision:99540/0,audio-analyzer:55680/0',
    )
  })

  it('names the PRODUCED categories, and how many children wanted each', () => {
    // D467: `fanoutTop` names subscribers; this names producers. The per-child
    // counters are (event × child) pairs — on a 39-child node they read ~38x
    // the production rate — so the category line is the only one that answers
    // "how many events a minute does this cluster actually emit".
    const line = formatEventPlane(
      diffEventPlane(
        EMPTY_EVENT_PLANE_BASELINE,
        counters({
          childrenConnected: 39,
          categories: [
            { category: 'pipeline.frame-analyzed', broadcasts: 6000, wanted: 6000 },
            { category: 'device.motion', broadcasts: 400, wanted: 800 },
            { category: 'provider.heartbeat', broadcasts: 120, wanted: 0 },
          ],
        }),
      ),
    )
    expect(line).toContain('fanoutEvents=6520')
    expect(line).toContain(
      'fanoutCats=pipeline.frame-analyzed:6000/6000,device.motion:400/800,' +
        'provider.heartbeat:120/0',
    )
  })

  it('names the ORPHAN categories — emitted, walked, wanted by NOBODY', () => {
    // An emit with zero subscribers still pays serialisation and the fan-out
    // walk. A branch that throws work away must say so, at zero as well as
    // above it, or "no orphans" is indistinguishable from "never looked".
    const clean = formatEventPlane(
      diffEventPlane(
        EMPTY_EVENT_PLANE_BASELINE,
        counters({
          childrenConnected: 39,
          categories: [{ category: 'device.motion', broadcasts: 400, wanted: 800 }],
        }),
      ),
    )
    expect(clean).toContain('fanoutOrphans=0')
    expect(clean).not.toContain('fanoutOrphanTop=')

    const wasteful = formatEventPlane(
      diffEventPlane(
        EMPTY_EVENT_PLANE_BASELINE,
        counters({
          childrenConnected: 39,
          categories: [
            { category: 'provider.heartbeat', broadcasts: 120, wanted: 0 },
            { category: 'stream.stats', broadcasts: 90, wanted: 0 },
            { category: 'device.motion', broadcasts: 400, wanted: 800 },
          ],
        }),
      ),
    )
    expect(wasteful).toContain('fanoutOrphans=210')
    expect(wasteful).toContain('fanoutOrphanTop=provider.heartbeat:120,stream.stats:90')
  })

  it('a census that overflowed says so, so a partial table is never read as whole', () => {
    const line = formatEventPlane(
      diffEventPlane(
        EMPTY_EVENT_PLANE_BASELINE,
        counters({ childrenConnected: 39, categoryOverflow: 17 }),
      ),
    )
    expect(line).toContain('fanoutCatsDropped=17')
  })

  it('a category the window did not move is absent from the table', () => {
    const w = diffEventPlane(
      {
        children: new Map(),
        categories: new Map([
          ['device.motion', { category: 'device.motion', broadcasts: 400, wanted: 800 }],
        ]),
        crossNodeDelivered: 0,
        crossNodeSuppressed: 0,
        categoryOverflow: 0,
      },
      counters({
        categories: [
          { category: 'device.motion', broadcasts: 400, wanted: 800 },
          { category: 'device.online', broadcasts: 3, wanted: 0 },
        ],
      }),
    )
    expect(w.categoryBroadcasts).toBe(3)
    expect(w.topCategories.map((c) => c.category)).toEqual(['device.online'])
    expect(w.orphanBroadcasts).toBe(3)
  })

  it('says NOTHING on a process with no event plane', () => {
    // ~38 runner lines share the hub's log stream. A plane that does not exist
    // must not be reported as a silent one.
    expect(formatEventPlane(undefined)).toBe('')
  })
})

describe('the reader, over the registries as they actually are', () => {
  function fakeRegistry(over: Partial<ChildFanoutRegistry> = {}): ChildFanoutRegistry {
    const stats = new Map<string, ChildFanoutSample>(
      LIVE_CHILDREN.map((c) => [c.childId, c] as const),
    )
    return {
      listChildren: () => [...stats.keys()].map((childId) => ({ childId })),
      getChildEventStats: (childId) => stats.get(childId) ?? null,
      undeclaredChildCount: () => 0,
      categoryFanout: () => [],
      categoryCensusOverflow: () => 0,
      ...over,
    }
  }

  it('reports NOTHING until the registry exists — the watch starts before it does', () => {
    const read = createEventPlaneReader({
      registry: () => null,
      crossNodeStats: () => null,
    })
    expect(read()).toBeUndefined()
  })

  it('a child with no recorded events is absent, not zero', () => {
    const read = createEventPlaneReader({
      registry: () =>
        fakeRegistry({
          listChildren: () => [{ childId: 'ml' }, { childId: 'never-spoke' }],
          getChildEventStats: (id) => (id === 'ml' ? { sent: 4920, suppressed: 0 } : null),
        }),
      crossNodeStats: () => ({ delivered: 1, suppressed: 2 }),
    })
    const snapshot = read()
    expect(snapshot?.children.map((c) => c.childId)).toEqual(['ml'])
    // …but it is still CONNECTED, and the connected count says so.
    expect(snapshot?.childrenConnected).toBe(2)
  })

  it('a registry mid-teardown never takes down the process watching it', () => {
    const read = createEventPlaneReader({
      registry: () => {
        throw new Error('closing')
      },
      crossNodeStats: () => null,
    })
    expect(read()).toBeUndefined()
  })

  it('a broker with no cross-node event yet reads zero, not undefined', () => {
    const read = createEventPlaneReader({
      registry: () => fakeRegistry(),
      crossNodeStats: () => null,
    })
    expect(read()?.crossNodeDelivered).toBe(0)
  })
})

const MB = 1048576
const QUIET_LOOP: LoopDelayMeter = { read: () => ZERO_LOOP_DELAY, stop: () => {} }

function mem(): NodeJS.MemoryUsage {
  return {
    rss: 1988 * MB,
    heapUsed: 1439 * MB,
    heapTotal: 1870 * MB,
    external: 5 * MB,
    arrayBuffers: 2 * MB,
  } as NodeJS.MemoryUsage
}

describe('the heartbeat carries it', () => {
  function firstLine(counters_: EventPlaneCounters | undefined): string {
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startHeapWatch(
      'hub-main',
      { info, warn },
      HEAP_WATCH_INTERVAL_MS,
      { readMemory: mem, heapLimitBytes: 4288 * MB, reclaim: vi.fn() },
      QUIET_LOOP,
      ['--max-old-space-size=3072'],
      false,
      undefined,
      { readSpaces: () => [], eventPlane: () => counters_ },
    )
    stop()
    return String(info.mock.calls[0]?.[0] ?? '')
  }

  it('puts the fan-out on hub-main, after everything already on the line', () => {
    const line = firstLine(
      counters({
        children: LIVE_CHILDREN,
        childrenConnected: 38,
        crossNodeDelivered: 412,
        crossNodeSuppressed: 88,
      }),
    )
    expect(line.startsWith('[mem] hub-main rss=1988MB heapUsed=1439MB')).toBe(true)
    expect(line.indexOf('fanoutSent=')).toBeGreaterThan(line.indexOf('loopMax='))
    expect(line).toContain('fanoutSent=760120')
    expect(line).toContain('fanoutTop=pipeline-analytics:347640/0')
  })

  it('leaves a runner line exactly as it was — a runner has no children', () => {
    const line = firstLine(undefined)
    expect(line).toBe(
      '[mem] hub-main rss=1988MB heapUsed=1439MB heapTotal=1870MB heapLimit=4288MB ' +
        'used=34% external=5MB arrayBuffers=2MB loopP50=0ms loopP99=0ms loopMax=0ms',
    )
  })
})
