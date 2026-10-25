/**
 * `AudioChunkPlane` — the broker's serialisable decoded audio-chunk surface
 * (Phase 5 / D9).
 *
 * This is the poll-based replacement for `StreamBroker.onDecodedAudioChunk`'s
 * live-object callback path. A live callback cannot cross a process boundary;
 * once the `pipeline` group is dissolved (Task 8) the audio consumer
 * (`pipeline-orchestrator`) runs in a different process from the broker, so
 * audio delivery must go over tRPC like the video frame plane.
 *
 * ## Why no shared memory
 *
 * Unlike video frames (~6 MB at 1080p RGB), a decoded audio chunk is tiny — a
 * ~500ms `AudioCodecSession` window is a few KB of Float32 PCM. Tiny payloads
 * serialise over tRPC cheaply, so audio ships its bytes INLINE on the RPC
 * wire; there is no shm ring.
 *
 * ## FIFO / no-drop queue policy
 *
 * Audio wants FIFO arrival order with no latest-wins drop: a missing chunk is
 * an audible gap and breaks the audio analyzer's fixed-length analysis
 * window. Each subscription therefore owns a generously-sized FIFO queue
 * (`AUDIO_QUEUE_CAPACITY`). Chunks arrive roughly every
 * `AudioCodecSession`-window (~500ms), so the queue buffers tens of seconds
 * of audio — a healthy poll loop never fills it. The queue only drops its
 * OLDEST chunk if a truly stalled consumer lets it overflow (a bounded safety
 * valve, not the steady-state behaviour).
 */
import { randomUUID } from 'node:crypto'

import { RingBuffer, expandAudioChunkToF32le } from '@camstack/types'
import type { AudioChunkFormat, DecodedAudioChunk, IScopedLogger } from '@camstack/types'

/**
 * Per-subscription FIFO capacity. A chunk is a few KB and arrives ~every
 * 500ms, so 64 buffers ~30s of audio between two `pullAudioChunks` polls
 * without unbounded growth.
 */
export const AUDIO_QUEUE_CAPACITY = 64

/**
 * Re-state a standing overflow at most this often (D465). The line fires when a
 * subscription STARTS overwriting, and again every 30 s while it still is — a
 * per-chunk warn is ~25 writes/s per camera of synchronous winston on the
 * broker's event loop, which is the cost the `pullPcm` warn coalescing exists
 * to avoid.
 */
const OVERFLOW_RELOG_MS = 30_000

/**
 * How long a subscription may go without a `pull` before the plane releases it
 * (D461).
 *
 * Until 2026-09-11 the one subscriber was `pipeline-orchestrator`, which the
 * hub restarts alongside the broker, and an abandoned subscription was a
 * theoretical leak. D461 moved the poller into `audio-analyzer`, which may sit
 * on another node and may die without the orchestrator's detach ever
 * arriving — and on THIS plane an orphan is not merely a queue nobody drains.
 * `subscriberCount` is what `hasDemand()` reads, so one orphan pins the
 * broker's source dial and its decode session open for the broker's whole
 * life: a camera nobody is listening to, kept streaming and decoding by a dead
 * process.
 *
 * The bound has to clear the longest LEGITIMATE gap between two polls. The
 * poller awaits its consumer per chunk, and the consumer is now the classifier
 * itself, whose `classify` carries a 30 s timeout — so a gap of tens of
 * seconds is healthy. Two minutes is past every one of those and well past the
 * ~30 s of audio the FIFO can hold, so a subscription this idle has already
 * lost audio and cannot be serving anyone.
 */
export const AUDIO_SUBSCRIPTION_IDLE_MS = 120_000

/** A consumer's decoded audio-chunk subscription. */
interface AudioChunkSubscription {
  readonly id: string
  /** Short caller-identity tag for diagnostics (`audio-analyzer`, …). */
  readonly tag: string
  /** Ms epoch the subscription was opened. */
  readonly subscribedAt: number
  /** Bounded FIFO chunk queue drained by `pullAudioChunks`. */
  readonly queue: RingBuffer<DecodedAudioChunk>
  /**
   * Byte formats this consumer declared it can READ. Empty means it declared
   * nothing, which means `f32le` and nothing else (D455) — the plane expands
   * for it, exactly as it did before the source-bytes lever existed.
   */
  readonly accept: ReadonlySet<AudioChunkFormat>
  /**
   * `<source>><served>` of the last chunk delivered — the state behind the
   * D427 serving line. It keys on BOTH halves, not just what was delivered: a
   * camera flipping from coded G.711 to the codec session's f32le changes what
   * this plane received even when a legacy subscriber sees f32le either way,
   * and that change is the one that re-prices a leg.
   */
  servedKey: string | null
  chunksDelivered: number
  /**
   * Chunks this subscription's FIFO overwrote because it was full — audio this
   * consumer will never see (D465). Reported on the OVERFLOW line and on the
   * idle-lease REAPED line, so a gap is countable rather than inferred.
   */
  chunksDropped: number
  /** True while the FIFO is overwriting, so the line fires per EPISODE. */
  overflowing: boolean
  /** Ms epoch of the last OVERFLOW line, for the re-log throttle. */
  lastOverflowLogAt: number
  /**
   * Ms epoch of the last `pull`, seeded with `subscribedAt`. The idle lease
   * (D461) is measured from here — a consumer that stopped draining is the
   * only evidence the broker has that the process on the other end is gone.
   */
  lastPulledAt: number
}

/** `format` is optional on the wire and its absence means `f32le` (D455). */
function formatOf(chunk: DecodedAudioChunk): AudioChunkFormat {
  return chunk.format ?? 'f32le'
}

/**
 * Build the f32le twin of a coded chunk. Everything but `data` and `format`
 * is carried over — the rate, the channel count and the timestamp describe the
 * audio, not its encoding.
 */
function expandChunk(chunk: DecodedAudioChunk, sourceFormat: AudioChunkFormat): DecodedAudioChunk {
  const bytes = expandAudioChunkToF32le(chunk.data, sourceFormat)
  return {
    data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    sampleRate: chunk.sampleRate,
    channels: chunk.channels,
    timestamp: chunk.timestamp,
    format: 'f32le',
  }
}

/** A diagnostic row for one audio-chunk subscription (mirrors `BrokerAudioClient`). */
export interface AudioChunkSubscriberInfo {
  readonly tag: string
  readonly subscribedAt: number
  readonly chunksDelivered: number
}

/**
 * Owns the broker's decoded audio-chunk subscriptions. The broker feeds every
 * decoded `DecodedAudioChunk` into `fanout`; each subscription's poll loop
 * drains its own FIFO queue via `pull`.
 */
export class AudioChunkPlane {
  private readonly logger: IScopedLogger | undefined
  private readonly subscriptions = new Map<string, AudioChunkSubscription>()
  /** Last `reapIdle` sweep — the lease is checked on a cadence, not per chunk. */
  private lastReapAt = Date.now()
  private readonly onSubscriptionsReaped: (() => void) | undefined

  constructor(logger?: IScopedLogger, onSubscriptionsReaped?: () => void) {
    this.logger = logger
    this.onSubscriptionsReaped = onSubscriptionsReaped
  }

  /** Number of active audio-chunk subscriptions — surfaced as audio demand. */
  get subscriberCount(): number {
    return this.subscriptions.size
  }

  /**
   * Register an audio-chunk subscription. The returned `subscriptionId` is
   * the handle the consumer passes to `pull` / `unsubscribe`.
   */
  subscribe(input?: { readonly tag?: string; readonly accept?: readonly AudioChunkFormat[] }): {
    subscriptionId: string
  } {
    const subscriptionId = `ac-${randomUUID()}`
    const subscription: AudioChunkSubscription = {
      id: subscriptionId,
      tag: input?.tag ?? 'unknown',
      subscribedAt: Date.now(),
      queue: new RingBuffer<DecodedAudioChunk>(AUDIO_QUEUE_CAPACITY),
      accept: new Set(input?.accept ?? []),
      servedKey: null,
      chunksDelivered: 0,
      chunksDropped: 0,
      overflowing: false,
      lastOverflowLogAt: 0,
      lastPulledAt: Date.now(),
    }
    this.subscriptions.set(subscriptionId, subscription)
    this.logger?.info('audio-chunk subscription added', {
      meta: {
        subscriptionId,
        tag: subscription.tag,
        // What this consumer said it can read. `[]` is a consumer that
        // declared nothing and will be served f32le forever — on a fleet of
        // G.711 cameras that is four bytes per sample on every leg, so the
        // list being empty is worth seeing at subscribe time rather than
        // inferring from a byte census (D455).
        accept: input?.accept ?? [],
      },
    })
    return { subscriptionId }
  }

  /**
   * Drain up to `maxCount` `DecodedAudioChunk`s for a subscription, in FIFO
   * arrival order. An unknown subscription id returns `[]` (the consumer may
   * have been torn down concurrently).
   */
  pull(subscriptionId: string, maxCount: number): readonly DecodedAudioChunk[] {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return []
    subscription.lastPulledAt = Date.now()
    const chunks = subscription.queue.drain(maxCount)
    subscription.chunksDelivered += chunks.length
    return chunks
  }

  /**
   * Release every subscription nobody has drained for
   * {@link AUDIO_SUBSCRIPTION_IDLE_MS}, and NAME each one (D461, D427).
   *
   * The lease is the net under the ownership split: the subscriber lives in a
   * process the orchestrator does not supervise, so a missed `detachDevice`
   * has to be survivable rather than trusted. It is deliberately driven from
   * `fanout` — the plane has no clock of its own, and the moment a dead
   * consumer costs anything is the moment there is a chunk to put in its
   * queue. A plane with nothing flowing has nothing to reclaim.
   *
   * Returns the ids released so the broker can re-evaluate its demand; an
   * orphan that is dropped but still counted would have fixed nothing.
   */
  reapIdle(now: number = Date.now()): readonly string[] {
    const reaped: string[] = []
    for (const subscription of [...this.subscriptions.values()]) {
      const idleMs = now - subscription.lastPulledAt
      if (idleMs < AUDIO_SUBSCRIPTION_IDLE_MS) continue
      this.subscriptions.delete(subscription.id)
      reaped.push(subscription.id)
      this.logger?.warn('audio-chunk subscription REAPED — nobody drained it', {
        meta: {
          subscriptionId: subscription.id,
          tag: subscription.tag,
          idleMs,
          leaseMs: AUDIO_SUBSCRIPTION_IDLE_MS,
          queued: subscription.queue.size,
          chunksDelivered: subscription.chunksDelivered,
          chunksDropped: subscription.chunksDropped,
          hint: 'the consumer process died without detaching — its subscription was holding this broker in demand',
        },
      })
    }
    return reaped
  }

  /** Release a subscription. Returns `true` when a known subscription was released. */
  unsubscribe(subscriptionId: string): boolean {
    const existed = this.subscriptions.delete(subscriptionId)
    if (existed) {
      this.logger?.info('audio-chunk subscription removed', {
        meta: { subscriptionId },
      })
    }
    return existed
  }

  /**
   * Fan one decoded `DecodedAudioChunk` into every active subscription's FIFO
   * queue. A full queue drops its oldest chunk (bounded safety valve for a
   * stalled consumer). No-op when there are no subscriptions.
   *
   * ## The format each subscription gets (D455)
   *
   * The decoder now hands this plane the SOURCE bytes — one G.711 byte per
   * sample instead of four f32le ones — because the plane crosses hub-main
   * twice on its way to the analyzer and every leg was paying the expansion.
   * A subscription receives those bytes only if it DECLARED it can read them;
   * otherwise the plane expands to `f32le` here, which is byte-for-byte what
   * every consumer received before this existed.
   *
   * The expansion is done ONCE per fanout and shared by every subscription
   * that needs it: the chunk is immutable and the queue holds references.
   */
  fanout(chunk: DecodedAudioChunk): void {
    this.maybeReap()
    const sourceFormat = formatOf(chunk)
    let expanded: DecodedAudioChunk | null = null

    for (const subscription of this.subscriptions.values()) {
      const wantsSource = sourceFormat === 'f32le' || subscription.accept.has(sourceFormat)
      if (wantsSource) {
        this.noteServed(subscription, sourceFormat, sourceFormat)
        this.enqueue(subscription, chunk)
        continue
      }
      expanded ??= expandChunk(chunk, sourceFormat)
      this.noteServed(subscription, sourceFormat, 'f32le')
      this.enqueue(subscription, expanded)
    }
  }

  /**
   * Push one chunk into a subscription's FIFO and NAME the loss when the FIFO
   * had no room (D465).
   *
   * `RingBuffer.push` overwrites its oldest entry. Every docblock on this path
   * called that "a bounded safety valve, not the steady-state behaviour" and
   * nothing ever said when the valve opened, so a consumer polling too slowly
   * for its producer lost audio permanently and in silence — the exact shape
   * CLAUDE.md forbids. The realistic cause is a cadence chosen for the
   * BOUNDARY rather than for the producer's chunk rate: 500 ms of a ~42 ms AAC
   * chunk is ~12 chunks against a batch that used to drain 8.
   */
  private enqueue(subscription: AudioChunkSubscription, chunk: DecodedAudioChunk): void {
    const wasFull = subscription.queue.size >= AUDIO_QUEUE_CAPACITY
    subscription.queue.push(chunk)
    if (!wasFull) {
      subscription.overflowing = false
      return
    }
    subscription.chunksDropped += 1
    const now = Date.now()
    const isNewEpisode = !subscription.overflowing
    subscription.overflowing = true
    if (!isNewEpisode && now - subscription.lastOverflowLogAt < OVERFLOW_RELOG_MS) return
    subscription.lastOverflowLogAt = now
    this.logger?.warn('audio-chunk subscription OVERFLOW — oldest audio overwritten', {
      meta: {
        subscriptionId: subscription.id,
        tag: subscription.tag,
        capacity: AUDIO_QUEUE_CAPACITY,
        chunksDropped: subscription.chunksDropped,
        chunksDelivered: subscription.chunksDelivered,
        hint: 'the consumer is pulling slower than this camera produces — its poll cadence or drain batch is wrong for the producer, not the boundary',
      },
    })
  }

  /**
   * Run the idle-lease sweep on a cadence rather than on every chunk. A quarter
   * of the lease bounds how long an orphan outlives its bound by, and keeps
   * the per-chunk cost of `fanout` a single clock read.
   */
  private maybeReap(): void {
    const now = Date.now()
    if (now - this.lastReapAt < AUDIO_SUBSCRIPTION_IDLE_MS / 4) return
    this.lastReapAt = now
    if (this.reapIdle(now).length > 0) this.onSubscriptionsReaped?.()
  }

  /**
   * Say what a subscription is being served — once, and again on every change.
   *
   * The audio decision of a relay is never silent (D427). Two things this line
   * answers that nothing else can: a consumer receiving a format it did not
   * expect (the failure that would otherwise surface as a level of +43 dBFS
   * with no cause), and a leg still paying 4x because its consumer declared no
   * `accept` — `expanded: true` is the byte cost, named where it is incurred.
   */
  private noteServed(
    subscription: AudioChunkSubscription,
    sourceFormat: AudioChunkFormat,
    servedFormat: AudioChunkFormat,
  ): void {
    const key = `${sourceFormat}>${servedFormat}`
    if (subscription.servedKey === key) return
    const previous = subscription.servedKey
    subscription.servedKey = key
    this.logger?.info('audio-chunk subscription serving', {
      meta: {
        subscriptionId: subscription.id,
        tag: subscription.tag,
        sourceFormat,
        servedFormat,
        expanded: servedFormat !== sourceFormat,
        previous,
      },
    })
  }

  /** Diagnostic snapshot of every active audio-chunk subscription. */
  listSubscribers(): readonly AudioChunkSubscriberInfo[] {
    return [...this.subscriptions.values()].map((s) => ({
      tag: s.tag,
      subscribedAt: s.subscribedAt,
      chunksDelivered: s.chunksDelivered,
    }))
  }

  /**
   * Force-release every subscription whose tag matches `tag`. Returns the
   * number released.
   */
  killByTag(tag: string): number {
    const victims = [...this.subscriptions.values()].filter((s) => s.tag === tag).map((s) => s.id)
    for (const id of victims) {
      this.subscriptions.delete(id)
    }
    return victims.length
  }

  /** Tear down every subscription. Idempotent. */
  dispose(): void {
    this.subscriptions.clear()
  }
}
