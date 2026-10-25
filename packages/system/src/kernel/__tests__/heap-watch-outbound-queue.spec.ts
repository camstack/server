/**
 * The heartbeat carries every outbound queue it can reach and names one that
 * holds (D446).
 *
 * Two planes, appended after the socket-plane fields so no Loki prefix moves:
 * the UDS children (`socketQueued`, from the channel's `writableLength`) and
 * the Moleculer writer sockets (`meshQueued`, the unref'd handles that
 * `_getActiveHandles()` never lists). Judged on EVERY probe, like the RSS
 * budget and the ArrayBuffer census, because the 2026-09-10 releases took
 * under 2 s.
 *
 * Disarms:
 *  - delete `judgeOutboundQueues(counters, mesh, at)` from `tick` → the
 *    "names a queue that holds" test red;
 *  - drop `formatMeshQueue` from the line → the "carries meshQueued" test red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HEAP_WATCH_FAST_INTERVAL_MS,
  HEAP_WATCH_INTERVAL_MS,
  type LoopDelayMeter,
  startHeapWatch,
  ZERO_LOOP_DELAY,
} from '../heap-watch.js'
import type { MeshPeerQueue } from '../moleculer/mesh-queue-report.js'
import { OUTBOUND_QUEUE_SUSTAIN_MS } from '../outbound-queue-watch.js'
import type { SocketPlaneCounters } from '../socket-plane-report.js'
import { EMPTY_SOCKET_DIRECTION } from '../transport/socket-traffic.js'

const MB = 1048576
const QUIET_LOOP: LoopDelayMeter = { read: () => ZERO_LOOP_DELAY, stop: () => {} }

function mem(): NodeJS.MemoryUsage {
  return {
    rss: 5000 * MB,
    heapUsed: 2400 * MB,
    heapTotal: 2600 * MB,
    external: 600 * MB,
    arrayBuffers: 20 * MB,
  }
}

interface Harness {
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
  readonly setUdsQueue: (bytes: number) => void
  readonly setMeshQueue: (bytes: number) => void
  readonly advance: (ms: number) => Promise<void>
  readonly stop: () => void
}

function harness(): Harness {
  vi.useFakeTimers()
  const info = vi.fn()
  const warn = vi.fn()
  let clock = 0
  let udsQueued = 0
  let meshQueued = 0
  const socketPlane = (): SocketPlaneCounters => ({
    peersConnected: 1,
    peers: [
      {
        peerId: 'pipeline-orchestrator',
        queuedBytes: udsQueued,
        tx: EMPTY_SOCKET_DIRECTION,
        rx: EMPTY_SOCKET_DIRECTION,
      },
    ],
  })
  const meshQueue = (): readonly MeshPeerQueue[] => [
    { nodeId: 'agent-a', queuedBytes: meshQueued, bytesWritten: 1 },
  ]
  const stop = startHeapWatch(
    'hub-main',
    { info, warn },
    HEAP_WATCH_INTERVAL_MS,
    { reclaim: () => {}, readMemory: mem, heapLimitBytes: 3264 * MB, now: () => clock },
    QUIET_LOOP,
    ['--max-old-space-size=3072'],
    false,
    undefined,
    { readSpaces: () => [], socketPlane, meshQueue },
  )
  return {
    info,
    warn,
    setUdsQueue: (bytes) => {
      udsQueued = bytes
    },
    setMeshQueue: (bytes) => {
      meshQueued = bytes
    },
    advance: async (ms) => {
      for (let elapsed = 0; elapsed < ms; elapsed += HEAP_WATCH_FAST_INTERVAL_MS) {
        clock += HEAP_WATCH_FAST_INTERVAL_MS
        await vi.advanceTimersByTimeAsync(HEAP_WATCH_FAST_INTERVAL_MS)
      }
    },
    stop,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

function lines(fn: ReturnType<typeof vi.fn>): readonly string[] {
  return fn.mock.calls.map((c) => String(c[0]))
}

describe('the [mem] line carries every outbound queue', () => {
  it('appends socketQueued and meshQueued after the socket-plane fields', () => {
    const h = harness()
    try {
      h.setUdsQueue(3 * MB)
      h.setMeshQueue(7 * MB)
      // The first line is printed synchronously at start; re-read on the next
      // one so the values set above are on it.
      const first = lines(h.warn)
        .concat(lines(h.info))
        .find((l) => l.includes('socketQueued='))
      expect(first).toBeDefined()
      expect(first).toMatch(/ socketRx=[^ ]+ socketQueued=/)
      expect(first).toContain(' meshQueued=')
    } finally {
      h.stop()
    }
  })
})

describe('a queue that holds is named, and its release is timestamped', () => {
  it('names the UDS peer once the queue has held for the sustain window, then the release', async () => {
    const h = harness()
    try {
      h.setUdsQueue(200 * MB)
      await h.advance(OUTBOUND_QUEUE_SUSTAIN_MS - HEAP_WATCH_FAST_INTERVAL_MS)
      expect(
        lines(h.warn).some((l) => l.includes('outbound queue to uds:pipeline-orchestrator')),
      ).toBe(false)
      await h.advance(3 * HEAP_WATCH_FAST_INTERVAL_MS)
      const named = lines(h.warn).filter((l) =>
        l.includes('outbound queue to uds:pipeline-orchestrator'),
      )
      expect(named).toHaveLength(1)
      expect(named[0]).toContain('200MB')

      h.setUdsQueue(0)
      await h.advance(HEAP_WATCH_FAST_INTERVAL_MS)
      const released = lines(h.warn).filter(
        (l) => l.includes('uds:pipeline-orchestrator') && l.includes('RELEASED'),
      )
      expect(released).toHaveLength(1)
      expect(released[0]).toContain('200MB')
    } finally {
      h.stop()
    }
  })

  it('names a Moleculer writer socket by node — the plane _getActiveHandles() never listed', async () => {
    const h = harness()
    try {
      h.setMeshQueue(4_900 * MB)
      await h.advance(OUTBOUND_QUEUE_SUSTAIN_MS + 3 * HEAP_WATCH_FAST_INTERVAL_MS)
      const named = lines(h.warn).filter((l) => l.includes('outbound queue to mesh:agent-a'))
      expect(named).toHaveLength(1)
      expect(named[0]).toContain('4900MB')
    } finally {
      h.stop()
    }
  })
})
