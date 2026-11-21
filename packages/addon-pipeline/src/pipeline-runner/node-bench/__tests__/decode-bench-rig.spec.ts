/**
 * D1078 — the decode rig on fake decode workers: one worker per stream
 * through the session decode coordinator, every stream dialing its own
 * loopback restream with the detection intent, the window counting what each
 * delivered and how late, a worker that names no decoder left unknown, a
 * stream refused before its fork when the node is out of RAM, and every
 * worker stopped at close.
 */
import type { IScopedLogger, NodeDecodeProfile } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ForkedChildLike } from '../../../session-decode/session-decode-coordinator.js'
import { testLease } from '../../../session-decode/__tests__/test-lease-knobs.js'
import type { VideoFrameSource } from '../../../session-decode/video-frame-generator.js'
import type { WorkerReply, WorkerRequest } from '../../../session-decode/worker-protocol.js'
import type { DecodeRig } from '../decode-bench-driver.js'
import { openDecodeBenchRig } from '../decode-bench-rig.js'
import type { DecodeBenchSource } from '../decode-bench-source.js'

const FHD: NodeDecodeProfile = {
  width: 1920,
  height: 1080,
  fps: 15,
  codec: 'h264',
}

const SOURCE: DecodeBenchSource = {
  profile: FHD,
  origin: 'synthetic',
  accessUnits: Array.from({ length: 30 }, (_, i) => ({
    data: Buffer.from([0, 0, 0, 1, 0x69, 0x10, 0, 0, 1, i % 15 === 0 ? 0x65 : 0x61, i]),
    keyframe: i % 15 === 0,
  })),
}

interface FakeWorker {
  readonly source: VideoFrameSource
  readonly requests: WorkerRequest[]
  killed: boolean
  /** Answer the pending pull with a frame shot `ageMs` ago. */
  frame(ageMs: number): void
  emit(reply: WorkerReply): void
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

function harness(over: { backend?: string | null; admit?: () => string | null } = {}) {
  const workers: FakeWorker[] = []
  let frameId = 0
  const fork = (source: VideoFrameSource): ForkedChildLike => {
    const handlers: Array<(m: unknown) => void> = []
    const exits: Array<(m: unknown) => void> = []
    const worker: FakeWorker = {
      source,
      requests: [],
      killed: false,
      emit: (reply) => {
        for (const h of handlers) h(reply)
      },
      frame: (ageMs) => {
        frameId += 1
        worker.emit({
          kind: 'frame',
          frameId,
          timestamp: frameId,
          width: 1920,
          height: 1080,
          format: 'rgb',
          capturedAt: Date.now() - ageMs,
        })
      },
    }
    workers.push(worker)
    return {
      send: (msg) => {
        worker.requests.push(msg)
        if (msg.kind === 'start' && over.backend !== null) {
          queueMicrotask(() =>
            worker.emit({
              kind: 'dialTiming',
              hwContextMs: 1,
              demuxerOpenMs: 1,
              decoderCreateMs: 1,
              firstDecodeMs: 1,
              streamInfoProbed: false,
              ...(typeof over.backend === 'string' ? { decodeBackend: over.backend } : {}),
            }),
          )
        }
        if (msg.kind === 'stop' || msg.kind === 'drain') {
          queueMicrotask(() => {
            worker.emit({ kind: 'ended' })
            for (const h of exits) h({ code: 0, signal: null })
          })
        }
      },
      on: (ev, cb) => {
        if (ev === 'message') handlers.push(cb)
        else exits.push(cb)
      },
      kill: () => {
        worker.killed = true
        for (const h of exits) h({ code: null, signal: 'SIGKILL' })
      },
    }
  }
  const open = (): Promise<DecodeRig> =>
    openDecodeBenchRig({
      source: SOURCE,
      motionFps: 5,
      fork,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      motion: null,
      admit: over.admit ?? (() => null),
      firstFrameTimeoutMs: 300,
    })
  return { workers, open }
}

async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!check()) throw new Error('not yet')
  })
}

/** Keep answering every stream's pulls until `done` resolves. */
async function feedWhile<T>(workers: FakeWorker[], ageMs: number, done: Promise<T>): Promise<T> {
  let finished = false
  void done.finally(() => {
    finished = true
  })
  while (!finished) {
    for (const w of workers) w.frame(ageMs)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return done
}

const rigs: DecodeRig[] = []
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close()
})

describe('openDecodeBenchRig', () => {
  it('forks one worker per stream, each on its own loopback restream with the detection intent', async () => {
    const { workers, open } = harness({ backend: 'vaapi' })
    const rig = await open()
    rigs.push(rig)
    const scaled = await feedWhile(workers, 10, rig.scaleTo(2))
    expect(scaled).toEqual({ ready: true, reason: null })
    expect(workers).toHaveLength(2)
    const urls = workers.map((w) => w.source.restreamUrl)
    expect(new Set(urls).size).toBe(2)
    for (const url of urls)
      expect(url).toMatch(/^rtsp:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/muted-detection$/)
    const start = workers[0]?.requests.find((r) => r.kind === 'start')
    // every decoded picture is delivered: no delivery rate is asked for
    expect(start?.kind === 'start' ? start.opts.fps : null).toBeUndefined()
    // growing keeps the streams already running
    await feedWhile(workers, 10, rig.scaleTo(3))
    expect(workers).toHaveLength(3)
  })

  it('the window counts what each stream delivered, how late, and on which decoder', async () => {
    const { workers, open } = harness({ backend: 'vaapi' })
    const rig = await open()
    rigs.push(rig)
    await feedWhile(workers, 10, rig.scaleTo(2))
    rig.beginWindow()
    const fed = (async (): Promise<void> => {
      for (let i = 0; i < 6; i++) {
        workers[0]?.frame(40)
        if (i < 3) workers[1]?.frame(400)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    })()
    await fed
    const windows = rig.endWindow()
    expect(windows.map((w) => w.frames)).toEqual([6, 3])
    expect(windows[0]?.ageP95Ms).toBeGreaterThanOrEqual(40)
    expect(windows[0]?.ageP95Ms).toBeLessThan(200)
    expect(windows[1]?.ageP95Ms).toBeGreaterThanOrEqual(400)
    expect(windows.map((w) => w.decoder)).toEqual(['vaapi', 'vaapi'])
    expect(windows.map((w) => w.errors)).toEqual([0, 0])
  })

  it('a worker that named no decoder is unknown, not software', async () => {
    const { workers, open } = harness({ backend: null })
    const rig = await open()
    rigs.push(rig)
    await feedWhile(workers, 10, rig.scaleTo(1))
    rig.beginWindow()
    expect(rig.endWindow()[0]?.decoder).toBeNull()
  })

  it('a stream that delivers nothing is not ready, and says which', async () => {
    const { open } = harness({ backend: 'software' })
    const rig = await open()
    rigs.push(rig)
    const scaled = await rig.scaleTo(1)
    expect(scaled.ready).toBe(false)
    expect(scaled.reason).toMatch(/^unresolved: stream 1 /)
  })

  it('a worker error inside the window is counted on its stream', async () => {
    const { workers, open } = harness({ backend: 'software' })
    const rig = await open()
    rigs.push(rig)
    await feedWhile(workers, 10, rig.scaleTo(1))
    rig.beginWindow()
    workers[0]?.emit({ kind: 'error', message: 'decoder died' })
    await until(() => (rig.endWindow()[0]?.errors ?? 0) > 0)
  })

  it('refuses the next stream BEFORE forking it when the node is out of room', async () => {
    let room = true
    const { workers, open } = harness({
      backend: 'software',
      admit: () => (room ? null : 'ram free 9% < 15%'),
    })
    const rig = await open()
    rigs.push(rig)
    await feedWhile(workers, 10, rig.scaleTo(1))
    room = false
    expect(await rig.scaleTo(3)).toEqual({
      ready: false,
      reason: 'ram free 9% < 15%',
    })
    expect(workers).toHaveLength(1)
  })

  it('close stops every worker', async () => {
    const { workers, open } = harness({ backend: 'software' })
    const rig = await open()
    await feedWhile(workers, 10, rig.scaleTo(2))
    await feedWhile(workers, 10, rig.close())
    for (const w of workers) {
      expect(w.killed || w.requests.some((r) => r.kind === 'stop' || r.kind === 'drain')).toBe(true)
    }
  })
})
