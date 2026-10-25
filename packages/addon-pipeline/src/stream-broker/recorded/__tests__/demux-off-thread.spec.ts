import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  createOffThreadJsParse,
  type DemuxWorkerCtor,
  type DemuxWorkerLike,
  type DemuxWorkerOptions,
} from '../demux-off-thread'
import type { AccessUnit } from '../segment-demux'

const AU: AccessUnit = {
  data: new Uint8Array([0, 0, 0, 1, 0x65]),
  ptsMs: 0,
  keyframe: true,
  codec: 'H264',
}

function trackedWorkerCtor(spawned: FakeWorker[]): DemuxWorkerCtor {
  return class TrackedFakeWorker extends FakeWorker {
    constructor(filename: string, options?: DemuxWorkerOptions) {
      super(filename, options)
      spawned.push(this)
    }
  }
}

class FakeWorker extends EventEmitter implements DemuxWorkerLike {
  constructor(_filename?: string, _options?: DemuxWorkerOptions) {
    super()
  }

  readonly posted: unknown[] = []
  postMessage(value: unknown, _transfer?: readonly Transferable[]): void {
    this.posted.push(value)
    const msg = value as { readonly id: number }
    queueMicrotask(() => this.emit('message', { id: msg.id, ok: true, aus: [AU] }))
  }
  terminate(): void {
    this.emit('exit', 0)
  }
}

describe('createOffThreadJsParse', () => {
  it('falls back to in-process parse when the worker file is missing', async () => {
    const parseInProcess = vi.fn(async (_bytes: Uint8Array) => [AU])
    const parse = createOffThreadJsParse({
      workerFilename: '/no/such/demux-worker-child.js',
      existsSync: () => false,
      parseInProcess,
    })
    const bytes = Uint8Array.of(1, 2, 3)
    await expect(parse(bytes)).resolves.toEqual([AU])
    expect(parseInProcess).toHaveBeenCalledOnce()
    expect(parseInProcess.mock.calls[0]![0]).toBe(bytes)
  })

  it('returns worker AUs without touching the event-loop parse', async () => {
    const parseInProcess = vi.fn(async () => {
      throw new Error('in-process parse must not run when the worker serves')
    })
    const spawned: FakeWorker[] = []
    const parse = createOffThreadJsParse({
      workerFilename: '/built/demux-worker-child.js',
      existsSync: () => true,
      parseInProcess,
      WorkerCtor: trackedWorkerCtor(spawned),
    })
    const bytes = Uint8Array.of(4, 5, 6)
    await expect(parse(bytes)).resolves.toEqual([AU])
    expect(parseInProcess).not.toHaveBeenCalled()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.posted).toHaveLength(1)
  })

  it('returns null (ffmpeg fallback) when the worker errors a job', async () => {
    class ErrorWorker extends EventEmitter implements DemuxWorkerLike {
      constructor(_filename?: string, _options?: DemuxWorkerOptions) {
        super()
      }

      postMessage(value: unknown, _transfer?: readonly Transferable[]): void {
        const msg = value as { readonly id: number }
        queueMicrotask(() =>
          this.emit('message', { id: msg.id, ok: false, error: 'mp4box exploded' }),
        )
      }
      terminate(): void {}
    }
    const parse = createOffThreadJsParse({
      workerFilename: '/built/demux-worker-child.js',
      existsSync: () => true,
      parseInProcess: async () => [AU],
      WorkerCtor: ErrorWorker,
    })
    await expect(parse(Uint8Array.of(1))).resolves.toBeNull()
  })

  it('matches concurrent jobs by id, not arrival order', async () => {
    class DelayedWorker extends EventEmitter implements DemuxWorkerLike {
      constructor(_filename?: string, _options?: DemuxWorkerOptions) {
        super()
      }

      postMessage(value: unknown, _transfer?: readonly Transferable[]): void {
        const msg = value as { readonly id: number; readonly bytes: Uint8Array }
        const delay = msg.bytes[0] === 1 ? 20 : 0
        const au: AccessUnit = { ...AU, ptsMs: msg.bytes[0] ?? 0 }
        setTimeout(() => this.emit('message', { id: msg.id, ok: true, aus: [au] }), delay)
      }
      terminate(): void {}
    }
    const parse = createOffThreadJsParse({
      workerFilename: '/built/demux-worker-child.js',
      existsSync: () => true,
      parseInProcess: async () => null,
      WorkerCtor: DelayedWorker,
    })
    const [slow, fast] = await Promise.all([parse(Uint8Array.of(1)), parse(Uint8Array.of(2))])
    expect(slow?.[0]?.ptsMs).toBe(1)
    expect(fast?.[0]?.ptsMs).toBe(2)
  })
})

describe('the transferred buffer is never the caller’s — a Node Buffer must survive', () => {
  /**
   * The 1.5 s freeze on every COLD seek, traced 2026-08-26 on camera 3839.
   *
   * `bytes.slice()` COPIES for a `Uint8Array` and ALIASES for a Node `Buffer`
   * (`Buffer.prototype.slice` is `subarray`). Transferring `copy.buffer` then
   * detaches the CALLER's array as well. The parameter is typed `Uint8Array`
   * and a `Buffer` IS one, so the type cannot tell them apart while the two
   * behave oppositely at runtime.
   *
   * Measured consequence: `readBytes` 0 on 487/487 whole reads and `bytes` 0 on
   * 55/55 seeks — AFTER a demux that had succeeded. The audio branch then
   * sliced an empty range, fell through to the ffmpeg fallback on empty stdin,
   * and burned `AUDIO_DEMUX_TIMEOUT_MS = 1500` in full: cold seek p50 1 498 ms
   * of frozen picture against 6 ms warm, 129×. Recorded audio was silently dead
   * on every cold seek, and the once-per-session "audio track is not Opus
   * (legacy fragment)" warning was a misdiagnosis — no track because no bytes.
   *
   * Asserted on the OWNERSHIP of the transferred buffer rather than by
   * simulating a transfer: that is the property the fix must hold, and it is
   * deterministic.
   */
  it('hands the worker a buffer the caller does not own', async () => {
    const transferred: ArrayBufferLike[] = []
    const parse = createOffThreadJsParse({
      existsSync: () => true,
      workerFilename: '/fake/worker.js',
      parseInProcess: async () => null,
      WorkerCtor: class {
        on(): void {}
        postMessage(_req: unknown, transfer: readonly ArrayBufferLike[]): void {
          transferred.push(...transfer)
        }
        unref(): void {}
      },
    } as unknown as Parameters<typeof createOffThreadJsParse>[0])

    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
    void parse(bytes)

    expect(transferred).toHaveLength(1)
    // Before the fix these are the SAME object, so the transfer detaches the
    // caller's bytes and every later read of them sees 0.
    expect(transferred[0]).not.toBe(bytes.buffer)
  })
})
