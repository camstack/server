/**
 * D660 — the classifier never drops a window SILENTLY because another camera
 * got there first.
 *
 * One YAMNet subprocess serves every camera on a node (~23 on the hub). The
 * windows arrive in bursts (per-camera pollers at 200–500 ms), and until D660 a
 * global `pipelineBusy` gate plus a per-camera 500 ms gate answered every
 * window that lost the race with `{ labels: [], inferenceMs: 0 }` — measured
 * live 2026-09-27: 1–10% of windows labelled on every camera while the model
 * sat at 7.5% CPU, and a crying rule that never fired.
 *
 * What must hold now:
 *   1. a burst from N cameras is classified WHOLE, in arrival order;
 *   2. the only drop is a camera's OLDER pending window superseded by its own
 *      newer one — and it is counted and reported per camera;
 *   3. a window that was not classified SAYS so (`classifyOutcome`), and is
 *      never shaped like "classified, nothing above the floor" (D393).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudioChunkInput, IScopedLogger } from '@camstack/types'
import { AudioAnalyzerProvider } from '../index.js'
import type {
  AudioBackend,
  AudioChunk,
  AudioClassificationResult,
  IAudioPipeline,
} from '../../../audio-pipeline.js'
import { AudioDeviceAttachments } from '../../../audio-device-attachments.js'
import { AudioBackendExitedError } from '../../../audio-subprocess-channel.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

/** A 1 s 16 kHz window whose every sample is `marker` — the pipeline reads it back. */
function windowFor(deviceId: number, marker: number): AudioChunkInput {
  const f32 = new Float32Array(16000).fill(marker)
  return {
    data: new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength),
    sampleRate: 16000,
    channels: 1,
    timestamp: 1_000 + marker,
    deviceId,
  }
}

interface GatedPipeline {
  readonly pipeline: IAudioPipeline
  /** Markers in the order the model actually ran them. */
  readonly ran: number[]
  /** Release the oldest in-flight inference. */
  release(): void
  readonly inFlight: () => number
}

/**
 * A pipeline whose every inference waits to be released — the only way to
 * hold "one inference in flight" still while a burst lands behind it.
 */
function makeGatedPipeline(
  result: AudioClassificationResult = {
    classifications: [{ className: 'Dog', score: 0.9 }],
    inferenceMs: 12,
  },
): GatedPipeline {
  const ran: number[] = []
  const waiting: (() => void)[] = []
  const pipeline: IAudioPipeline = {
    initialize: async () => {},
    classify: async (chunk: AudioChunk) => {
      ran.push(chunk.data[0] ?? Number.NaN)
      await new Promise<void>((resolve) => waiting.push(resolve))
      return result
    },
    dispose: async () => {},
    getPid: () => null,
  }
  return {
    pipeline,
    ran,
    release: () => waiting.shift()?.(),
    inFlight: () => waiting.length,
  }
}

function makeProvider(
  log: IScopedLogger,
  pipeline: IAudioPipeline,
  backend: AudioBackend = 'yamnet-onnx',
): AudioAnalyzerProvider {
  const attachments = new AudioDeviceAttachments({
    api: () => null,
    localNodeId: () => 'hub',
    logger: log,
    analyse: async () => null,
    emitResult: () => undefined,
  })
  return new AudioAnalyzerProvider(
    log,
    async () => pipeline,
    backend,
    async () => null,
    async () => null,
    async () => {},
    async () => ({ backend: 'yamnet-onnx' }),
    attachments,
  )
}

const SETTINGS = { minConfidence: 0.3, allowedClasses: [] }

/** Let queued microtasks (the queue's drain hops) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Release inferences one at a time until nothing is waiting. */
async function drainAll(g: GatedPipeline): Promise<void> {
  for (let guard = 0; guard < 100; guard++) {
    await flush()
    if (g.inFlight() === 0) return
    g.release()
  }
}

describe('AudioAnalyzerProvider — one pipeline, many cameras, no silent drop (D660)', () => {
  let provider: AudioAnalyzerProvider | null = null
  afterEach(async () => {
    await provider?.dispose()
    provider = null
  })

  it('classifies EVERY camera of a burst that lands while one inference is in flight, in arrival order', async () => {
    const log = makeLogger()
    const g = makeGatedPipeline()
    provider = makeProvider(log, g.pipeline)

    // Camera 1 takes the pipeline…
    const first = provider.analyseChunk({ chunk: windowFor(601, 1), settings: SETTINGS })
    await flush()
    expect(g.inFlight()).toBe(1)

    // …and four more cameras' windows land behind it, together.
    const burst = [602, 603, 604, 605].map((deviceId, i) =>
      provider!.analyseChunk({ chunk: windowFor(deviceId, i + 2), settings: SETTINGS }),
    )
    await drainAll(g)
    const results = await Promise.all([first, ...burst])

    expect(g.ran).toEqual([1, 2, 3, 4, 5])
    for (const r of results) {
      expect(r?.classifyOutcome).toEqual({ state: 'classified' })
      expect(r?.classification?.labels[0]?.className).toBe('dog')
    }
  })

  it("supersedes only a camera's OLDER pending window, counts it, and reports it per camera", async () => {
    const log = makeLogger()
    const g = makeGatedPipeline()
    provider = makeProvider(log, g.pipeline)

    const a1 = provider.analyseChunk({ chunk: windowFor(101, 1), settings: SETTINGS })
    await flush()
    const a2 = provider.analyseChunk({ chunk: windowFor(101, 2), settings: SETTINGS })
    const b1 = provider.analyseChunk({ chunk: windowFor(102, 3), settings: SETTINGS })
    const a3 = provider.analyseChunk({ chunk: windowFor(101, 4), settings: SETTINGS })
    await drainAll(g)
    const [r1, r2, rb, r3] = await Promise.all([a1, a2, b1, a3])

    // a2 was superseded by a3 and never reached the model; a3 kept a2's place
    // in the line, so camera 101 did not lose its turn to 102 by being fast.
    expect(g.ran).toEqual([1, 4, 3])
    expect(r1?.classifyOutcome).toEqual({ state: 'classified' })
    expect(r2?.classifyOutcome).toEqual({ state: 'not-classified', reason: 'superseded' })
    expect(r2?.classification).toBeUndefined()
    // The level is still measured on a window the model never saw.
    expect(r2?.level.dbfs).toBeCloseTo(20 * Math.log10(2), 1)
    expect(rb?.classifyOutcome).toEqual({ state: 'classified' })
    expect(r3?.classifyOutcome).toEqual({ state: 'classified' })

    provider.reportClassifyAccounting()
    const lines = vi
      .mocked(log.info)
      .mock.calls.filter(([msg]) => msg === 'audio classify accounting')
    // Only the camera that lost a window gets a line — never one per window.
    expect(lines).toHaveLength(1)
    expect(lines[0]![1]).toMatchObject({
      tags: { deviceId: 101 },
      meta: { classified: 2, superseded: 1, errors: 0 },
    })

    // The counters are per period: a second report with nothing new is silent.
    provider.reportClassifyAccounting()
    expect(
      vi.mocked(log.info).mock.calls.filter(([msg]) => msg === 'audio classify accounting'),
    ).toHaveLength(1)
  })

  it('names a failed inference as not-classified (error), never as an empty classification', async () => {
    const log = makeLogger()
    const pipeline: IAudioPipeline = {
      initialize: async () => {},
      classify: async () => {
        throw new Error('yamnet timeout')
      },
      dispose: async () => {},
      getPid: () => null,
    }
    provider = makeProvider(log, pipeline)
    const r = await provider.analyseChunk({ chunk: windowFor(101, 1), settings: SETTINGS })
    expect(r?.classifyOutcome).toEqual({ state: 'not-classified', reason: 'error' })
    expect(r?.classification).toBeUndefined()
  })

  it('says "classified" when the model ran and nothing cleared the floor', async () => {
    const log = makeLogger()
    const g = makeGatedPipeline({
      classifications: [{ className: 'Dog', score: 0.1 }],
      inferenceMs: 9,
    })
    provider = makeProvider(log, g.pipeline)
    const p = provider.analyseChunk({ chunk: windowFor(101, 1), settings: SETTINGS })
    await drainAll(g)
    const r = await p
    expect(r?.classification).toBeUndefined()
    expect(r?.classifyOutcome).toEqual({ state: 'classified' })
  })

  it('logs a watched macro heard BELOW the camera floor, rate-limited per camera', async () => {
    const log = makeLogger()
    const g = makeGatedPipeline({
      classifications: [{ className: 'Baby cry, infant cry', score: 0.21 }],
      inferenceMs: 9,
    })
    provider = makeProvider(log, g.pipeline)
    for (const marker of [1, 2, 3]) {
      const p = provider.analyseChunk({ chunk: windowFor(101, marker), settings: SETTINGS })
      await drainAll(g)
      await p
    }
    const p2 = provider.analyseChunk({ chunk: windowFor(102, 9), settings: SETTINGS })
    await drainAll(g)
    await p2

    const lines = vi
      .mocked(log.info)
      .mock.calls.filter(([msg]) => msg === 'audio near-miss below floor')
    expect(lines).toHaveLength(2)
    expect(lines[0]![1]).toMatchObject({
      tags: { deviceId: 101 },
      meta: { label: 'crying', score: 0.21, floor: 0.3 },
    })
    expect(lines[1]![1]).toMatchObject({ tags: { deviceId: 102 } })
  })

  /**
   * BOTH backends (YAMNet's Python subprocess and Apple SoundAnalysis's CLI)
   * hold ONE `pendingResolve` slot: a second classify() while one is
   * outstanding overwrites the first's resolver, and the first times out.
   * This fake has exactly that shape — an overlapping call FAILS — so the
   * serialisation is proved above the backend, for either of them.
   */
  it.each<AudioBackend>([
    'yamnet-onnx',
    'apple-soundanalysis',
  ])('never overlaps two inferences on the single-slot %s backend, and serves the whole burst', async (backend) => {
    const log = makeLogger()
    const ran: number[] = []
    let slot: (() => void) | null = null
    let overlaps = 0
    const pipeline: IAudioPipeline = {
      initialize: async () => {},
      classify: async (chunk: AudioChunk) => {
        if (slot !== null) overlaps += 1
        ran.push(chunk.data[0] ?? Number.NaN)
        await new Promise<void>((resolve) => {
          slot = resolve
          // Answers on a later macrotask, like a subprocess reply.
          setTimeout(() => {
            slot = null
            resolve()
          }, 1)
        })
        return { classifications: [{ className: 'Dog', score: 0.9 }], inferenceMs: 1 }
      },
      dispose: async () => {},
      getPid: () => null,
    }
    provider = makeProvider(log, pipeline, backend)
    const results = await Promise.all(
      [701, 702, 703, 704, 705, 706].map((deviceId, i) =>
        provider!.analyseChunk({ chunk: windowFor(deviceId, i + 1), settings: SETTINGS }),
      ),
    )
    expect(overlaps).toBe(0)
    expect(ran).toEqual([1, 2, 3, 4, 5, 6])
    for (const r of results) expect(r?.classifyOutcome).toEqual({ state: 'classified' })
  })
})

/**
 * D660 round 1 — the ONE inference every camera waits behind must always
 * end. A backend killed by a signal, disposed under the call, or simply hung
 * must fail THAT window (not-classified) and let the next camera through on a
 * fresh backend — never leave the queue `running` forever.
 */
interface KillablePipeline {
  readonly pipeline: IAudioPipeline
  readonly ran: number[]
  /** The process died by a signal: every waiting call rejects, as the channel does. */
  exitBySignal(): void
  disposed(): boolean
}

function makeKillablePipeline(hang: boolean): KillablePipeline {
  const ran: number[] = []
  const waiting: ((err: Error) => void)[] = []
  let wasDisposed = false
  const failAll = (why: string): void => {
    for (const reject of waiting.splice(0)) reject(new AudioBackendExitedError(why))
  }
  const pipeline: IAudioPipeline = {
    initialize: async () => {},
    classify: async (chunk: AudioChunk) => {
      ran.push(chunk.data[0] ?? Number.NaN)
      if (!hang) return { classifications: [{ className: 'Dog', score: 0.9 }], inferenceMs: 5 }
      return new Promise<AudioClassificationResult>((_, reject) => waiting.push(reject))
    },
    dispose: async () => {
      wasDisposed = true
      failAll('disposed')
    },
    getPid: () => null,
  }
  return {
    pipeline,
    ran,
    exitBySignal: () => failAll('process exited (code null, signal SIGTERM)'),
    disposed: () => wasDisposed,
  }
}

function makeRespawningProvider(
  log: IScopedLogger,
  builds: readonly KillablePipeline[],
): { provider: AudioAnalyzerProvider; buildCount: () => number } {
  let built = 0
  const attachments = new AudioDeviceAttachments({
    api: () => null,
    localNodeId: () => 'hub',
    logger: log,
    analyse: async () => null,
    emitResult: () => undefined,
  })
  const provider = new AudioAnalyzerProvider(
    log,
    async () => {
      const next = builds[built]
      built += 1
      if (!next) throw new Error('no more fake pipelines')
      return next.pipeline
    },
    'yamnet-onnx',
    async () => null,
    async () => null,
    async () => {},
    async () => ({ backend: 'yamnet-onnx' }),
    attachments,
  )
  return { provider, buildCount: () => built }
}

describe('AudioAnalyzerProvider — the running inference always ends (D660 round 1)', () => {
  let provider: AudioAnalyzerProvider | null = null
  afterEach(async () => {
    vi.useRealTimers()
    await provider?.dispose()
    provider = null
  })

  it('a backend killed by a signal mid-inference fails that window, and the next camera is served on a respawned backend', async () => {
    const log = makeLogger()
    const dead = makeKillablePipeline(true)
    const fresh = makeKillablePipeline(false)
    const h = makeRespawningProvider(log, [dead, fresh])
    provider = h.provider

    const first = provider.analyseChunk({ chunk: windowFor(101, 1), settings: SETTINGS })
    await flush()
    const second = provider.analyseChunk({ chunk: windowFor(102, 2), settings: SETTINGS })
    await flush()
    dead.exitBySignal()
    const [r1, r2] = await Promise.all([first, second])

    expect(r1?.classifyOutcome).toEqual({ state: 'not-classified', reason: 'error' })
    expect(r2?.classifyOutcome).toEqual({ state: 'classified' })
    expect(fresh.ran).toEqual([2])
    expect(h.buildCount()).toBe(2)
  })

  it('a backend swapped (disposed) mid-inference fails that window, and the next camera is served by the new one', async () => {
    const log = makeLogger()
    const old = makeKillablePipeline(true)
    const next = makeKillablePipeline(false)
    const h = makeRespawningProvider(log, [old])
    provider = h.provider

    const first = provider.analyseChunk({ chunk: windowFor(101, 1), settings: SETTINGS })
    await flush()
    const second = provider.analyseChunk({ chunk: windowFor(102, 2), settings: SETTINGS })
    await flush()
    await provider.swapPipeline(next.pipeline, 'yamnet-onnx')
    const [r1, r2] = await Promise.all([first, second])

    expect(old.disposed()).toBe(true)
    expect(r1?.classifyOutcome).toEqual({ state: 'not-classified', reason: 'error' })
    expect(r2?.classifyOutcome).toEqual({ state: 'classified' })
    expect(next.ran).toEqual([2])
  })

  it('an analyzer disposed mid-inference settles the running window AND the waiting ones', async () => {
    const log = makeLogger()
    const hung = makeKillablePipeline(true)
    const h = makeRespawningProvider(log, [hung])
    provider = h.provider

    const first = provider.analyseChunk({ chunk: windowFor(101, 1), settings: SETTINGS })
    await flush()
    const second = provider.analyseChunk({ chunk: windowFor(102, 2), settings: SETTINGS })
    await flush()
    await provider.dispose()
    provider = null
    const [r1, r2] = await Promise.all([first, second])

    expect(r1?.classifyOutcome).toEqual({ state: 'not-classified', reason: 'error' })
    expect(r2?.classifyOutcome).toEqual({ state: 'not-classified', reason: 'disposed' })
  })

  it('an inference that never answers times out, is logged per camera, and the backend is replaced', async () => {
    vi.useFakeTimers()
    const log = makeLogger()
    const hung = makeKillablePipeline(true)
    const fresh = makeKillablePipeline(false)
    const h = makeRespawningProvider(log, [hung, fresh])
    provider = h.provider

    const first = provider.analyseChunk({ chunk: windowFor(101, 1), settings: SETTINGS })
    await flush()
    const second = provider.analyseChunk({ chunk: windowFor(102, 2), settings: SETTINGS })
    await flush()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fresh.ran).toEqual([])
    await vi.advanceTimersByTimeAsync(2)
    const [r1, r2] = await Promise.all([first, second])

    expect(r1?.classifyOutcome).toEqual({ state: 'not-classified', reason: 'timeout' })
    expect(r2?.classifyOutcome).toEqual({ state: 'classified' })
    expect(hung.disposed()).toBe(true)
    expect(fresh.ran).toEqual([2])
    const lines = vi
      .mocked(log.warn)
      .mock.calls.filter(([msg]) => String(msg).startsWith('audio inference timed out'))
    expect(lines).toHaveLength(1)
    expect(lines[0]![1]).toMatchObject({ tags: { deviceId: 101 }, meta: { timeoutMs: 5_000 } })
  })
})
