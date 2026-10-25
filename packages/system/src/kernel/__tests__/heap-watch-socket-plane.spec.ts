/**
 * The socket-plane fields on the `[mem]` line — and the promise that everything
 * already on it is untouched.
 *
 * Every Loki query written on 2026-08-29 matches this line by its prefix. Two
 * separate obligations follow, and they are asserted separately because they
 * fail for different reasons:
 *
 *  1. a process with a child registry gains `socketPeers` / `socketTx` /
 *     `socketRx` / `socketTop`, APPENDED after the fan-out fields;
 *  2. a process without one — every forked runner, and hub-main before
 *     `LocalChildRegistry` exists — emits byte-for-byte the line it emitted
 *     before. A plane that does not exist must never be reported as a silent
 *     one, and ~38 runner lines share this log stream.
 */
import { describe, expect, it, vi } from 'vitest'
import { HEAP_WATCH_INTERVAL_MS, startHeapWatch, ZERO_LOOP_DELAY } from '../heap-watch.js'
import type { LoopDelayMeter } from '../heap-watch.js'
import type { SocketPlaneCounters } from '../socket-plane-report.js'
import { EMPTY_SOCKET_DIRECTION, type SocketDirectionSample } from '../transport/socket-traffic.js'

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

function dir(over: Partial<SocketDirectionSample>): SocketDirectionSample {
  return { ...EMPTY_SOCKET_DIRECTION, ...over }
}

/**
 * The measured shape, 2026-08-29: ~22 500 writes/s and ~21 800 reads/s at a
 * 0.33–0.40 KB mean, with one peer holding 78–82% of outbound bytes and an
 * IDLE addon still reading 82 messages/s.
 */
const HUB_MAIN_MINUTE: SocketPlaneCounters = {
  peersConnected: 38,
  peers: [
    {
      queuedBytes: 0,
      peerId: 'pipeline-analytics',
      tx: dir({ evtMessages: 347_640, evtBytes: 139_056_000 }),
      rx: dir({ reqMessages: 47_640, reqBytes: 15_585_280 }),
    },
    {
      queuedBytes: 0,
      peerId: 'ml',
      tx: dir({ evtMessages: 4920, evtBytes: 1_608_000 }),
      rx: dir({}),
    },
  ],
}

function firstLine(plane: SocketPlaneCounters | undefined): string {
  const info = vi.fn()
  const stop = startHeapWatch(
    'hub-main',
    { info, warn: vi.fn() },
    HEAP_WATCH_INTERVAL_MS,
    { readMemory: mem, heapLimitBytes: 4288 * MB, reclaim: vi.fn() },
    QUIET_LOOP,
    ['--max-old-space-size=3072'],
    false,
    undefined,
    { readSpaces: () => [], socketPlane: () => plane },
  )
  stop()
  return String(info.mock.calls[0]?.[0] ?? '')
}

describe('a process that owns a child registry gains the attribution', () => {
  it('names the peer and the kind, both directions', () => {
    const line = firstLine(HUB_MAIN_MINUTE)
    expect(line).toContain(' socketPeers=2/38')
    expect(line).toContain(' socketTx=req:0/0kB,res:0/0kB,evt:352560/137367kB')
    expect(line).toContain(' socketRx=req:47640/15220kB,res:0/0kB,evt:0/0kB')
    // The whole point: a peer, a kind, and the bytes behind it.
    expect(line).toContain(
      'socketTop=pipeline-analytics:tx=0/0/347640:rx=47640/0/0:txkB=0/0/135797:rxkB=15220/0/0',
    )
    // An IDLE addon still costs 82 messages/s of fan-out — the per-runner floor
    // that makes this a plane problem rather than a caller problem.
    expect(line).toContain('ml:tx=0/0/4920:rx=0/0/0:txkB=0/0/1570:rxkB=0/0/0')
  })

  it('appends AFTER everything already on the line, never between two fields', () => {
    const line = firstLine(HUB_MAIN_MINUTE)
    expect(line.indexOf('socketPeers=')).toBeGreaterThan(line.indexOf('loopMax='))
    expect(line.indexOf('socketTx=')).toBeGreaterThan(line.indexOf('socketPeers='))
    expect(line.indexOf('socketTop=')).toBeGreaterThan(line.indexOf('socketRx='))
  })
})

describe('every field that was on this line before keeps its name and position', () => {
  it('a runner — no registry, no plane — emits byte-for-byte the line it always did', () => {
    // Deliberately an equality, not a `toContain`. ~38 runners share this log
    // stream and a single extra field on all of them is how a log stops being
    // read; this is also the assertion that catches a `formatSocketPlane` that
    // starts reporting zeros for a plane that does not exist.
    expect(firstLine(undefined)).toBe(
      '[mem] hub-main rss=1988MB heapUsed=1439MB heapTotal=1870MB heapLimit=4288MB ' +
        'used=34% external=5MB arrayBuffers=2MB loopP50=0ms loopP99=0ms loopMax=0ms',
    )
  })

  it('and hub-main keeps the same prefix, unchanged, with the plane present', () => {
    expect(
      firstLine(HUB_MAIN_MINUTE).startsWith(
        '[mem] hub-main rss=1988MB heapUsed=1439MB heapTotal=1870MB heapLimit=4288MB ' +
          'used=34% external=5MB arrayBuffers=2MB loopP50=0ms loopP99=0ms loopMax=0ms',
      ),
    ).toBe(true)
  })
})
