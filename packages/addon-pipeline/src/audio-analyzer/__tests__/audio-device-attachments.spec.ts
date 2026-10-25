/**
 * `AudioDeviceAttachments` — the analyzer's own broker subscriptions (D461).
 *
 * This is the half of the relay removal that has to be right, because it is
 * the half that changed OWNER. The orchestrator used to open the broker
 * subscription in its own process and hold the closure that closed it; now it
 * asks a different process — possibly on a different node — to do both. Three
 * things must hold or the move is a regression:
 *
 *   1. the coded bytes are asked for (`accept`), or the whole point is lost;
 *   2. an attach REPLACES a live one, or a re-attach doubles the fanout;
 *   3. a detach actually releases the broker's FIFO, because an orphan here is
 *      broker DEMAND — it pins the source dial open.
 *
 * And D427 on top of all three: what this leg is delivering is a line, and a
 * device that stops delivering must keep saying so.
 */
import type {
  AddonApi,
  AudioAnalysisSettings,
  AudioChunkInput,
  AudioResult,
  DecodedAudioChunkWire,
  IScopedLogger,
  LogExtras,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AudioDeviceAttachments, MAX_WINDOWS_AWAITING_RESULT } from '../audio-device-attachments.js'
import { LOCAL_POLL_INTERVAL_MS } from '../audio-chunk-poller.js'
import type { AudioAnalysisResult } from '../audio-window-accumulator.js'

const SETTINGS: AudioAnalysisSettings = { minConfidence: 0.3, allowedClasses: [] }

interface CapturedLine {
  readonly message: string
  readonly meta: Record<string, unknown>
}

class RecordingLogger implements IScopedLogger {
  constructor(private readonly lines: CapturedLine[]) {}

  private record(message: string, extras?: LogExtras): void {
    const meta = extras?.meta
    this.lines.push({
      message,
      meta: typeof meta === 'object' && meta !== null ? { ...meta } : {},
    })
  }

  debug(message: string, extras?: LogExtras): void {
    this.record(message, extras)
  }
  info(message: string, extras?: LogExtras): void {
    this.record(message, extras)
  }
  warn(message: string, extras?: LogExtras): void {
    this.record(message, extras)
  }
  error(message: string, extras?: LogExtras): void {
    this.record(message, extras)
  }
  child(): IScopedLogger {
    return this
  }
  withTags(): IScopedLogger {
    return this
  }
}

/** One `subscribeAudioChunks` the analyzer made against the broker. */
interface RecordedSubscribe {
  readonly brokerId: string
  readonly tag: string
  readonly accept: readonly string[] | undefined
  readonly nodePin: string | undefined
}

/**
 * A broker stub reachable only through the cross-addon API shape, because that
 * is the ONLY way the analyzer can reach it — the whole record is about the
 * fact that these two live in different processes.
 */
class FakeBroker {
  readonly subscribes: RecordedSubscribe[] = []
  readonly unsubscribes: string[] = []
  private nextId = 1
  private readonly queues = new Map<string, DecodedAudioChunkWire[]>()

  /** Queue a chunk for every live subscription, as `fanout` would. */
  deliver(chunk: DecodedAudioChunkWire): void {
    for (const queue of this.queues.values()) queue.push(chunk)
  }

  get liveSubscriptions(): number {
    return this.queues.size
  }

  readonly api: AddonApi = {
    streamBroker: {
      subscribeAudioChunks: {
        mutate: async (
          input: { brokerId: string; tag: string; accept?: readonly string[] },
          opts?: { context?: Record<string, unknown> },
        ): Promise<{ subscriptionId: string }> => {
          const subscriptionId = `ac-${this.nextId++}`
          this.subscribes.push({
            brokerId: input.brokerId,
            tag: input.tag,
            accept: input.accept,
            nodePin: readPin(opts),
          })
          this.queues.set(subscriptionId, [])
          return { subscriptionId }
        },
      },
      pullAudioChunks: {
        query: async (input: {
          subscriptionId: string
          maxCount: number
        }): Promise<readonly DecodedAudioChunkWire[]> => {
          const queue = this.queues.get(input.subscriptionId)
          if (!queue) return []
          return queue.splice(0, input.maxCount)
        },
      },
      unsubscribeAudioChunks: {
        mutate: async (input: { subscriptionId: string }): Promise<boolean> => {
          this.unsubscribes.push(input.subscriptionId)
          return this.queues.delete(input.subscriptionId)
        },
      },
    },
    // Documented type boundary: `AddonApi` is the fully expanded generated
    // tRPC client for every capability in the repo. A fake can only ever
    // implement the three procedures under test, and there is no narrower
    // supertype to declare against — the alternative is a 40 000-line stub.
  } as unknown as AddonApi
}

/** Read the node pin out of a cap-call option bag without knowing its key. */
function readPin(opts?: { context?: Record<string, unknown> }): string | undefined {
  const context = opts?.context
  if (!context) return undefined
  for (const value of Object.values(context)) {
    if (typeof value === 'string') return value
  }
  return undefined
}

/** 4 000 coded bytes = 500 ms of 8 kHz mono G.711 — what the decoder emits. */
function codedChunk(timestamp: number): DecodedAudioChunkWire {
  return {
    data: new Uint8Array(4000).fill(0xff),
    sampleRate: 8000,
    channels: 1,
    timestamp,
    format: 'pcmu',
  }
}

interface Harness {
  readonly attachments: AudioDeviceAttachments
  readonly broker: FakeBroker
  readonly lines: CapturedLine[]
  readonly emitted: { deviceId: number; frame: AudioResult }[]
  readonly analysed: AudioChunkInput[]
}

function makeHarness(localNodeId = 'hub'): Harness {
  const broker = new FakeBroker()
  const lines: CapturedLine[] = []
  const emitted: { deviceId: number; frame: AudioResult }[] = []
  const analysed: AudioChunkInput[] = []
  const attachments = new AudioDeviceAttachments({
    api: () => broker.api,
    localNodeId: () => localNodeId,
    logger: new RecordingLogger(lines),
    analyse: async (chunk): Promise<AudioAnalysisResult | null> => {
      analysed.push(chunk)
      return {
        level: { rms: 0.5, dbfs: -6 },
        classifyOutcome: { state: 'classified' },
        timestamp: chunk.timestamp,
      }
    },
    emitResult: (deviceId, frame) => {
      emitted.push({ deviceId, frame })
    },
  })
  return { attachments, broker, lines, emitted, analysed }
}

/** Let the poller's immediate first tick (and its awaits) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/**
 * Advance past one steady-state poll and let its awaits settle. The poller
 * self-schedules with `setTimeout`, so a chunk queued after the first
 * immediate tick is only seen on the next one.
 */
async function poll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(LOCAL_POLL_INTERVAL_MS + 10)
  await settle()
}

describe('AudioDeviceAttachments — the analyzer pulls its own audio (D461)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes to the broker itself, declaring the coded formats it can read', async () => {
    const h = makeHarness()
    h.attachments.attach({
      deviceId: 101,
      brokerId: '101/main',
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })
    await settle()

    expect(h.broker.subscribes).toHaveLength(1)
    const sub = h.broker.subscribes[0]
    expect(sub?.brokerId).toBe('101/main')
    // The subscriber IS the decoder now, which is exactly what lets the
    // remaining legs stay coded end to end. A poller that declared nothing
    // would be served f32le and the move would buy four bytes per sample back.
    expect(sub?.accept).toEqual(['pcmu', 'pcma'])
    // Every broker call is pinned to the node that owns the source dial.
    expect(sub?.nodePin).toBe('hub')
  })

  it('windows the coded chunks itself and emits ONE result per ~1 s window', async () => {
    const h = makeHarness()
    h.attachments.attach({
      deviceId: 101,
      brokerId: '101/main',
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })
    await settle()

    // 500 ms of coded audio: below the window target, so nothing leaves.
    h.broker.deliver(codedChunk(1_000))
    await poll()
    expect(h.analysed).toHaveLength(0)
    expect(h.emitted).toHaveLength(0)

    // The second chunk completes the second. One analysis, one event — and the
    // window handed to the model is f32le, four bytes per coded byte, because
    // the ONE expansion happens at the flush in this process.
    h.broker.deliver(codedChunk(1_500))
    await poll()
    expect(h.analysed).toHaveLength(1)
    expect(h.analysed[0]?.data.byteLength).toBe(8000 * 4)
    expect(h.analysed[0]?.sampleRate).toBe(8000)
    expect(h.emitted).toHaveLength(1)
    expect(h.emitted[0]?.deviceId).toBe(101)
    const emitted = h.emitted[0]
    expect(emitted?.frame?.level?.dbfs).toBe(-6)
  })

  it('says what the leg is delivering, once, with the byte format (D427)', async () => {
    const h = makeHarness()
    h.attachments.attach({
      deviceId: 101,
      brokerId: '101/main',
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })
    await settle()
    h.broker.deliver(codedChunk(1_000))
    h.broker.deliver(codedChunk(1_500))
    await poll()

    const delivering = h.lines.filter((l) => l.message === 'audio stream delivering')
    expect(delivering).toHaveLength(1)
    // `pcmu` here is the leg saying it is carrying one byte per sample. The
    // same line reading `f32le` on a G.711 camera is the leg saying it is
    // still paying four, which is the only way to see that from the consumer.
    expect(delivering[0]?.meta['format']).toBe('pcmu')
    expect(delivering[0]?.meta['sampleRate']).toBe(8000)
  })

  it('REPLACES a live attachment rather than stacking a second poller on it', async () => {
    const h = makeHarness()
    h.attachments.attach({
      deviceId: 101,
      brokerId: '101/main',
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })
    await settle()
    const second = h.attachments.attach({
      deviceId: 101,
      brokerId: '101/sub',
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })
    await settle()

    expect(second.replaced).toBe(true)
    expect(h.attachments.size).toBe(1)
    // Two pollers on one camera would double the broker's fanout and each
    // would flush its own half-windows — the prior subscription must be GONE
    // from the broker, not merely forgotten here.
    expect(h.broker.unsubscribes).toHaveLength(1)
    expect(h.broker.liveSubscriptions).toBe(1)
  })

  it('releases the broker FIFO on detach, and detach is idempotent', async () => {
    const h = makeHarness()
    h.attachments.attach({
      deviceId: 101,
      brokerId: '101/main',
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })
    await settle()

    expect(h.attachments.detach(101)).toEqual({ detached: true })
    await settle()
    expect(h.broker.liveSubscriptions).toBe(0)
    // A second detach must not throw and must not re-report — the orchestrator
    // can legitimately tear down twice (shutdown racing a rebalance).
    expect(h.attachments.detach(101)).toEqual({ detached: false })
    expect(h.broker.unsubscribes).toHaveLength(1)
  })

  it('releases EVERY attachment on shutdown and refuses to attach after it', async () => {
    const h = makeHarness()
    for (const deviceId of [101, 102, 108]) {
      h.attachments.attach({
        deviceId,
        brokerId: `${deviceId}/main`,
        ingestNodeId: 'hub',
        settings: SETTINGS,
      })
    }
    await settle()
    expect(h.broker.liveSubscriptions).toBe(3)

    h.attachments.detachAll()
    await settle()
    expect(h.broker.liveSubscriptions).toBe(0)

    // A queued reconcile landing after shutdown began must not resurrect a
    // subscription into a process that is going away — that is precisely the
    // orphan the broker would then have to reap.
    const late = h.attachments.attach({
      deviceId: 101,
      brokerId: '101/main',
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })
    expect(late.attached).toBe(false)
    expect(h.broker.liveSubscriptions).toBe(0)
    expect(h.lines.some((l) => l.message.includes('REFUSED'))).toBe(true)
  })

  it('polls slower when the broker is on another node', async () => {
    const h = makeHarness('mac-mini')
    h.attachments.attach({
      deviceId: 101,
      brokerId: '101/main',
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })
    await settle()

    // The poll loop moved to the consumer's side, so for a camera dispatched
    // away from the ingest node it now crosses the mesh rather than hub-main's
    // UDS. Keeping 200 ms would have tripled the mesh request rate while the
    // bytes were collapsing — the rate is a property of the boundary.
    const attached = h.lines.find((l) => l.message === 'audio attached')
    expect(attached?.meta['remoteBroker']).toBe(true)
    expect(attached?.meta['pollIntervalMs']).toBe(500)
  })

  it('names the camera whose attach it refused, rather than failing silently', () => {
    const lines: CapturedLine[] = []
    const attachments = new AudioDeviceAttachments({
      api: () => null,
      localNodeId: () => 'hub',
      logger: new RecordingLogger(lines),
      analyse: async () => null,
      emitResult: () => undefined,
    })

    const result = attachments.attach({
      deviceId: 101,
      brokerId: '101/main',
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })

    // A branch that drops work silently reads as "it never happened". This one
    // drops a whole camera's audio for the life of the dispatch.
    expect(result.attached).toBe(false)
    const refusal = lines.find((l) => l.message.includes('REFUSED'))
    expect(refusal).toBeDefined()
    expect(refusal?.meta['brokerId']).toBe('101/main')
  })

  it('keeps draining while a window waits for the classifier, and emits results in window order (D660)', async () => {
    const lines: CapturedLine[] = []
    const broker = new FakeBroker()
    const emitted: number[] = []
    const analysed: number[] = []
    const releases: (() => void)[] = []
    const attachments = new AudioDeviceAttachments({
      api: () => broker.api,
      localNodeId: () => 'hub',
      logger: new RecordingLogger(lines),
      // The classifier's queue: a window waits here while other cameras are
      // served. The poller must not wait with it, or the camera falls behind
      // the live edge and its NEWER window can never supersede this one.
      analyse: async (chunk): Promise<AudioAnalysisResult | null> => {
        analysed.push(chunk.timestamp)
        await new Promise<void>((resolve) => releases.push(resolve))
        return {
          level: { rms: 0.5, dbfs: -6 },
          timestamp: chunk.timestamp,
          classifyOutcome: { state: 'classified' },
        }
      },
      emitResult: (_deviceId, frame) => {
        emitted.push(frame.timestamp)
      },
    })
    attachments.attach({
      deviceId: 101,
      brokerId: '101/main',
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })
    await settle()

    for (const ts of [1_000, 1_500, 2_000, 2_500]) broker.deliver(codedChunk(ts))
    await poll()
    // Both windows reached the classifier although the first is still waiting.
    expect(analysed).toEqual([1_000, 2_000])
    expect(emitted).toEqual([])

    // The SECOND answers first — its result still waits for the first's.
    releases[1]?.()
    await settle()
    expect(emitted).toEqual([])
    releases[0]?.()
    await settle()
    await settle()
    expect(emitted).toEqual([1_000, 2_000])
    attachments.detachAll()
  })

  it('bounds the windows awaiting a result per camera — a stalled classifier cannot grow the chain (D660)', async () => {
    const lines: CapturedLine[] = []
    const broker = new FakeBroker()
    let analysed = 0
    const attachments = new AudioDeviceAttachments({
      api: () => broker.api,
      localNodeId: () => 'hub',
      logger: new RecordingLogger(lines),
      // A classifier that never answers.
      analyse: (): Promise<AudioAnalysisResult | null> => {
        analysed += 1
        return new Promise<AudioAnalysisResult | null>(() => undefined)
      },
      emitResult: () => undefined,
    })
    attachments.attach({
      deviceId: 101,
      brokerId: '101/main',
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })
    await settle()

    const windows = MAX_WINDOWS_AWAITING_RESULT + 4
    for (let i = 0; i < windows * 2; i++) broker.deliver(codedChunk(1_000 + i * 500))
    for (let i = 0; i < 12; i++) await poll()

    expect(analysed).toBe(MAX_WINDOWS_AWAITING_RESULT)
    const dropped = lines.filter((l) => l.message.startsWith('audio windows dropped'))
    // Counted and reported — once, not once per window.
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.meta['bound']).toBe(MAX_WINDOWS_AWAITING_RESULT)
    attachments.detachAll()
  })

  it('a window whose analysis REJECTS while an earlier one is still waiting is logged, never an unhandled rejection', async () => {
    const lines: CapturedLine[] = []
    const broker = new FakeBroker()
    const releases: (() => void)[] = []
    let calls = 0
    const attachments = new AudioDeviceAttachments({
      api: () => broker.api,
      localNodeId: () => 'hub',
      logger: new RecordingLogger(lines),
      analyse: async (chunk): Promise<AudioAnalysisResult | null> => {
        calls += 1
        if (calls === 2) throw new Error('analyse blew up')
        await new Promise<void>((resolve) => releases.push(resolve))
        return {
          level: { rms: 0.5, dbfs: -6 },
          timestamp: chunk.timestamp,
          classifyOutcome: { state: 'classified' },
        }
      },
      emitResult: () => undefined,
    })
    attachments.attach({
      deviceId: 101,
      brokerId: '101/main',
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })
    await settle()
    for (const ts of [1_000, 1_500, 2_000, 2_500]) broker.deliver(codedChunk(ts))
    await poll()
    // Let the rejection sit unobserved by the chain across real ticks — Node
    // reports an unhandled rejection from its tick queue, which fake timers
    // do not drive.
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => process.nextTick(resolve))
    releases[0]?.()
    await settle()
    await settle()
    expect(lines.some((l) => l.message === 'Audio analysis failed')).toBe(true)
    attachments.detachAll()
  })
})
