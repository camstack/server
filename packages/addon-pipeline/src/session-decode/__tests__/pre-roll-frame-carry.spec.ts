/**
 * The worker → pump seam, for the two facts a pre-roll frame has to survive
 * with: the moment it was SHOT, and that it is history.
 *
 * Both used to be destroyed here. The pump stamped `capturedAt: Date.now()`
 * unconditionally (`toDecodedFrame`), so a frame replayed out of ~4 s of
 * retained history was dated at session open — and there was nothing on the
 * frame to say it was history at all, so the only thing a consumer could do
 * with it was push it into the latest-only live queue.
 */
import type { DecodedFrame, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { ForkedChildLike } from '../session-decode-coordinator.js'
import { startSessionDecodePump } from '../session-decode-pump.js'
import type { VideoFrameSource } from '../video-frame-generator.js'
import type {
  WorkerPreRollReport,
  WorkerPreRollSettled,
  WorkerReply,
  WorkerRequest,
} from '../worker-protocol.js'
import { testLease } from './test-lease-knobs.js'

function createFakeChild(): {
  child: ForkedChildLike
  sent: WorkerRequest[]
  emit: (reply: WorkerReply) => void
} {
  const sent: WorkerRequest[] = []
  const handlers: Array<(m: unknown) => void> = []
  const child: ForkedChildLike = {
    send: (msg: WorkerRequest) => {
      sent.push(msg)
    },
    on: (ev: 'message' | 'exit', cb: (m: unknown) => void) => {
      if (ev === 'message') handlers.push(cb)
    },
    kill: vi.fn(),
  }
  return {
    child,
    sent,
    emit: (reply) => {
      for (const h of handlers) h(reply)
    },
  }
}

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const source: VideoFrameSource = { restreamUrl: 'rtsp://cam/102', deviceId: 102, codec: 'h264' }

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('pre-roll frame carry (worker → pump)', () => {
  it('carries the frame OWN moment and its pre-roll mark onto the DecodedFrame', async () => {
    const fake = createFakeChild()
    const delivered: DecodedFrame[] = []
    // The frame device 102's cyclist scored `vehicle 0.5669` on — 1.68 s before
    // the live track was born.
    const shotAt = 1_788_900_482_710

    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 12, format: 'rgb', preRollMs: 3994, preRollMaxFrames: 12 },
      onDecodedFrame: (frame) => {
        delivered.push(frame)
      },
    })

    await flush()
    fake.emit({
      kind: 'frame',
      frameId: 1,
      timestamp: shotAt,
      width: 640,
      height: 480,
      format: 'rgb',
      capturedAt: shotAt,
      preRoll: true,
    })
    await flush()
    fake.emit({ kind: 'buffer', frameId: 1, bytes: new Uint8Array([1, 2, 3]) })
    await flush()

    expect(delivered).toHaveLength(1)
    // NOT Date.now(). A live-stamped clock here would date the track's
    // firstSeen, its media and the notification's instant at session open.
    expect(delivered[0]?.capturedAt).toBe(shotAt)
    expect(delivered[0]?.preRoll).toBe(true)
    stop()
  })

  it('leaves a LIVE frame exactly as it was — no mark, and the wall clock stands in', async () => {
    const fake = createFakeChild()
    const delivered: DecodedFrame[] = []
    const before = Date.now()

    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 12, format: 'rgb' },
      onDecodedFrame: (frame) => {
        delivered.push(frame)
      },
    })

    await flush()
    // A worker that sends no `capturedAt` at all — the pre-change wire shape.
    fake.emit({ kind: 'frame', frameId: 1, timestamp: 5, width: 640, height: 480, format: 'rgb' })
    await flush()
    fake.emit({ kind: 'buffer', frameId: 1, bytes: new Uint8Array([1]) })
    await flush()

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.preRoll).toBeUndefined()
    expect(delivered[0]?.capturedAt ?? 0).toBeGreaterThanOrEqual(before)
    stop()
  })

  it('asks the materialize gate whether the frame is history BEFORE any pixels exist', async () => {
    // The gate has to know, because the live admission gate paces on wall clock
    // and would refuse the whole burst — before a single `toBuffer`.
    const fake = createFakeChild()
    const asked: boolean[] = []

    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 12, format: 'rgb', preRollMs: 3994, preRollMaxFrames: 12 },
      shouldMaterializeFrame: (preRoll) => {
        asked.push(preRoll)
        return false
      },
      onDecodedFrame: () => {},
    })

    await flush()
    fake.emit({
      kind: 'frame',
      frameId: 1,
      timestamp: 1,
      width: 640,
      height: 480,
      format: 'rgb',
      capturedAt: 1,
      preRoll: true,
    })
    await flush()

    expect(asked).toEqual([true])
    // Refused pixel-free: no `toBuffer` was ever sent for it.
    expect(fake.sent.some((m) => m.kind === 'toBuffer')).toBe(false)
    stop()
  })

  it('forwards the burst report so the owner can log what it dropped', async () => {
    const fake = createFakeChild()
    const reports: WorkerPreRollReport[] = []
    const settledLines: WorkerPreRollSettled[] = []

    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 12, format: 'rgb', preRollMs: 3994, preRollMaxFrames: 12 },
      onDecodedFrame: () => {},
      onPreRollReport: (report) => {
        reports.push(report)
      },
      onPreRollSettled: (summary) => {
        settledLines.push(summary)
      },
    })

    await flush()
    fake.emit({
      kind: 'preRollReport',
      offered: 47,
      inferred: 12,
      dropped: 35,
      droppedByReason: { stride: 34, 'live-edge': 1 },
      strideMs: 333,
      subsampled: true,
      spanMs: 3900,
      budgetFrames: 7,
    })
    fake.emit({
      kind: 'preRollSettled',
      read: 6,
      released: 0,
      lostByReason: { evicted: 1, cleared: 0, 'download-failed': 0, miss: 0 },
      unsettled: 0,
    })
    await flush()

    expect(reports).toHaveLength(1)
    expect(reports[0]?.inferred).toBe(12)
    // D652: the hold cap rides the report; the late loss rides its own line.
    expect(reports[0]?.budgetFrames).toBe(7)
    expect(settledLines).toEqual([
      {
        read: 6,
        released: 0,
        lostByReason: { evicted: 1, cleared: 0, 'download-failed': 0, miss: 0 },
        unsettled: 0,
      },
    ])
    expect(reports[0]?.dropped).toBe(35)
    expect(reports[0]?.droppedByReason['stride']).toBe(34)
    stop()
  })

  it('tells the worker what history to spend, on `start`', async () => {
    const fake = createFakeChild()
    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 12, format: 'rgb', preRollMs: 3994, preRollMaxFrames: 12 },
      onDecodedFrame: () => {},
    })
    await flush()
    const start = fake.sent.find((m) => m.kind === 'start')
    expect(start?.kind === 'start' && start.opts.preRollMs).toBe(3994)
    expect(start?.kind === 'start' && start.opts.preRollMaxFrames).toBe(12)
    stop()
  })
})
