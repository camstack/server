/**
 * `AudioDeviceAttachments` — the analyzer's own audio subscriptions (D461).
 *
 * ## What this replaces
 *
 * Until 2026-09-11 the decoded audio-chunk plane ran through
 * `pipeline-orchestrator`: it drained the broker's FIFO, accumulated ~1 s
 * windows and pushed them back out to `audioAnalyzer.analyseChunk`. The
 * orchestrator neither produced nor consumed the audio — it buffered it, and
 * every byte crossed hub-main twice for the privilege. The poller's own
 * docblock named the reason, and it was an accident: the code had been a
 * closure INSIDE the broker's process, and when the `pipeline` co-location
 * group was dissolved nobody moved it.
 *
 * D455 proved the relay was the PREMISE of the remaining cost rather than an
 * alternative to it. It put the SOURCE bytes on the plane — one G.711 byte per
 * sample instead of four f32le ones — but only for a consumer that declared it
 * could read them, and the accumulator (the declaring consumer) sat in a third
 * process that had to expand before forwarding. So legs one and two went coded
 * and legs three and four stayed at ~49 MB/min each. Here the subscriber IS
 * the decoder: there is no third interlocutor, the negotiation needs none, and
 * legs three and four do not exist.
 *
 * ## What the orchestrator still owns
 *
 * Everything about WHETHER and WHERE, which is all policy: the `audioMode`
 * gate, the on-motion window, the audio-track probe, the per-device node
 * assignment and the settings read. It calls `attachDevice` / `detachDevice`
 * and holds the teardown. What it no longer owns is the bytes.
 *
 * ## The failure this split ADDS, and where it is caught
 *
 * The broker subscription is now opened by a process the orchestrator does not
 * supervise. A detach that never arrives — an analyzer runner that crashed, a
 * node that went offline mid-teardown — leaves a FIFO nobody drains, and on
 * this plane that is not merely a leak: `AudioChunkPlane.subscriberCount` is
 * broker DEMAND, so an orphan pins the source dial and the decode session open
 * for as long as the broker lives. It is caught in the broker
 * (`AudioChunkPlane`'s idle lease), not here, because a process that has died
 * cannot clean up after itself.
 */
import { errMsg } from '@camstack/types'
import type {
  AddonApi,
  AudioAnalysisSettings,
  AudioAttachDeviceInput,
  AudioChunkInput,
  AudioResult,
  IScopedLogger,
} from '@camstack/types'

import {
  LOCAL_POLL_INTERVAL_MS,
  REMOTE_POLL_INTERVAL_MS,
  startAudioChunkPoller,
} from './audio-chunk-poller.js'
import type { AudioAnalysisResult } from './audio-window-accumulator.js'
import { AudioWindowAccumulator, buildAudioResultFrame } from './audio-window-accumulator.js'

/**
 * Windows of ONE camera that may be waiting for their result at once (D660
 * round 1). The poller does not await the classifier, so without a bound a
 * stall anywhere below it would grow this camera's emit chain by one window a
 * second forever. The analyzer bounds one inference at 5 s and a camera waits
 * behind at most one window per other camera (~23 × ~33 ms), so a healthy
 * camera holds ~1–6; 16 only trips when something below is stuck OUTSIDE those
 * bounds. Windows past it are dropped, counted and reported per camera.
 */
export const MAX_WINDOWS_AWAITING_RESULT = 16

/** One over-bound report per camera per this window; the rest are counted. */
const OVER_BOUND_LOG_INTERVAL_MS = 60_000

/** One live attachment: the poller teardown plus the window state it feeds. */
interface Attachment {
  readonly brokerId: string
  readonly teardown: () => void
  readonly accumulator: AudioWindowAccumulator
}

/**
 * Inputs `attachDevice` carries. `z.infer` off the cap's own schema — a second
 * hand-written shape for one contract is how the two drift apart.
 */
export type AudioAttachRequest = AudioAttachDeviceInput

export interface AudioDeviceAttachmentsDeps {
  /** Cross-addon API — `streamBroker` lives in another process (and maybe another node). */
  readonly api: () => AddonApi | null
  /** This analyzer's own node, to decide which boundary the poll loop crosses. */
  readonly localNodeId: () => string
  readonly logger: IScopedLogger
  /**
   * Run one window through the analyzer's own pipeline. Injected rather than
   * called through `ctx.api` — the analysis happens in THIS process and going
   * out to the cap surface to reach code one field away would put the window
   * back on the wire, which is the whole defect this record removes.
   */
  readonly analyse: (
    chunk: AudioChunkInput,
    settings: AudioAnalysisSettings,
  ) => Promise<AudioAnalysisResult | null>
  /**
   * Publish one analysed window. The orchestrator used to emit this event; it
   * now arrives from wherever the analyzer runs, which for a dispatched camera
   * is an agent — the hub's subscribers (recorder band decision,
   * pipeline-analytics, the HA export) receive it over the `camstack.evt.*`
   * broadcast exactly as they receive any agent-side event.
   */
  readonly emitResult: (deviceId: number, frame: AudioResult) => void
}

export class AudioDeviceAttachments {
  private readonly attachments = new Map<number, Attachment>()
  private shuttingDown = false

  constructor(private readonly deps: AudioDeviceAttachmentsDeps) {}

  /** Live attachment count — diagnostics only. */
  get size(): number {
    return this.attachments.size
  }

  /**
   * Open (or replace) this camera's audio pull. Returns as soon as the
   * attachment exists: the first `subscribeAudioChunks` retries with backoff
   * behind it, because the broker for a camStream may not be registered yet.
   * That boot-race tolerance travelled with the poller and is unchanged.
   *
   * Idempotent BY REPLACEMENT. Two pollers on one camera would double the
   * broker's fanout and each would flush its own half-windows; a re-attach
   * (a rebalance, a settings change, a watchdog recovery) must therefore drop
   * the prior one, and it is reported so an unexpected churn is visible.
   */
  attach(request: AudioAttachRequest): { attached: boolean; replaced: boolean } {
    if (this.shuttingDown) {
      this.deps.logger.warn('audio attach REFUSED — analyzer is shutting down', {
        tags: { deviceId: request.deviceId },
        meta: { brokerId: request.brokerId },
      })
      return { attached: false, replaced: false }
    }
    const api = this.deps.api()
    if (!api) {
      this.deps.logger.warn('audio attach REFUSED — no cross-addon api available', {
        tags: { deviceId: request.deviceId },
        meta: { brokerId: request.brokerId },
      })
      return { attached: false, replaced: false }
    }

    const replaced = this.releaseAttachment(request.deviceId, 'replaced')

    const { deviceId, brokerId, ingestNodeId, settings } = request
    const logger = this.deps.logger.withTags({ deviceId })
    const isRemoteBroker = ingestNodeId !== this.deps.localNodeId()

    // The D427 line, carried over verbatim in intent: the first format this
    // attachment delivers is a line, and a format that changes under an open
    // window names what it dropped rather than handing the classifier a
    // window of two rates.
    const accumulator = new AudioWindowAccumulator(deviceId, (change) => {
      const meta = {
        sampleRate: change.to.sampleRate,
        channels: change.to.channels,
        format: change.to.format,
        previous: change.from,
        droppedMs: change.droppedMs,
      }
      if (change.from === null) {
        logger.info('audio stream delivering', { tags: { deviceId }, meta })
        return
      }
      logger.warn('audio stream format changed — partial window dropped', {
        tags: { deviceId },
        meta,
      })
    })

    // Tail of this camera's result emissions — keeps them in window order.
    let emitChain: Promise<void> = Promise.resolve()
    // Windows handed to the classifier whose result is not emitted yet.
    let awaiting = 0
    let droppedOverBound = 0
    let lastOverBoundLogMs: number | null = null
    const reportOverBound = (): void => {
      droppedOverBound += 1
      const now = Date.now()
      if (lastOverBoundLogMs !== null && now - lastOverBoundLogMs < OVER_BOUND_LOG_INTERVAL_MS) {
        return
      }
      lastOverBoundLogMs = now
      logger.warn('audio windows dropped — too many already awaiting a result', {
        tags: { deviceId },
        meta: { dropped: droppedOverBound, bound: MAX_WINDOWS_AWAITING_RESULT, awaiting },
      })
      droppedOverBound = 0
    }

    const teardown = startAudioChunkPoller({
      api,
      brokerId,
      tag: 'audio-analyzer',
      ownerNodeId: ingestNodeId,
      // Now that the subscriber IS the decoder, the coded bytes travel the
      // whole way and the ONE expansion is the accumulator's flush, in this
      // process, next to the model (D455 §5, D461).
      accept: ['pcmu', 'pcma'],
      // The poll rate is a property of the boundary it crosses, and the
      // boundary changed with this move — see the poller's constants.
      pollIntervalMs: isRemoteBroker ? REMOTE_POLL_INTERVAL_MS : LOCAL_POLL_INTERVAL_MS,
      logger,
      onChunk: (chunk) => {
        let window: AudioChunkInput | null
        try {
          window = accumulator.push(chunk)
        } catch (err: unknown) {
          // Not a broker failure — say what it was, per camera, and keep polling.
          logger.error('audio window accumulate failed — chunk dropped', {
            tags: { deviceId },
            meta: { error: errMsg(err), timestamp: chunk.timestamp },
          })
          return
        }
        // Below the window target: accumulate only.
        if (!window) return
        if (awaiting >= MAX_WINDOWS_AWAITING_RESULT) {
          reportOverBound()
          return
        }
        awaiting += 1
        // NOT awaited (D660). The window waits in the classifier's queue
        // behind other cameras; the poller must keep draining meanwhile, or
        // the camera falls behind the live edge and its newer window can
        // never supersede this one. Results are emitted in WINDOW order: each
        // emit chains behind the previous window's.
        const analysed = this.deps.analyse(window, settings)
        // Observed now, so a rejection that lands before the previous link
        // settles is never an `unhandledRejection`; the chain below still
        // sees it and logs it.
        analysed.catch(() => undefined)
        emitChain = emitChain
          .then(() => analysed)
          .then((result) => {
            if (!result) return
            this.deps.emitResult(deviceId, buildAudioResultFrame(deviceId, result))
          })
          .catch((err: unknown) => {
            logger.error('Audio analysis failed', {
              tags: { deviceId },
              meta: { error: errMsg(err) },
            })
          })
          .finally(() => {
            awaiting -= 1
          })
      },
    })

    this.attachments.set(deviceId, { brokerId, teardown, accumulator })
    this.deps.logger.info('audio attached', {
      tags: { deviceId },
      meta: {
        brokerId,
        ingestNodeId,
        remoteBroker: isRemoteBroker,
        pollIntervalMs: isRemoteBroker ? REMOTE_POLL_INTERVAL_MS : LOCAL_POLL_INTERVAL_MS,
        replaced,
      },
    })
    return { attached: true, replaced }
  }

  /** Close this camera's audio pull and release the broker subscription. Idempotent. */
  detach(deviceId: number): { detached: boolean } {
    return { detached: this.releaseAttachment(deviceId, 'detached') }
  }

  /**
   * Release every attachment — the analyzer's own shutdown. This is the only
   * orderly path that can return the broker's FIFOs; a crash cannot, which is
   * what the plane's idle lease exists for.
   */
  detachAll(): void {
    this.shuttingDown = true
    for (const deviceId of [...this.attachments.keys()]) {
      this.releaseAttachment(deviceId, 'shutdown')
    }
  }

  private releaseAttachment(deviceId: number, reason: string): boolean {
    const existing = this.attachments.get(deviceId)
    if (!existing) return false
    this.attachments.delete(deviceId)
    try {
      existing.teardown()
    } catch (err: unknown) {
      this.deps.logger.warn('audio detach: poller teardown threw', {
        tags: { deviceId },
        meta: { brokerId: existing.brokerId, reason, error: errMsg(err) },
      })
    }
    // Drop any partially-accumulated window so the buffered PCM is released
    // promptly (no trailing flush — a sub-second partial window is not worth a
    // classify during teardown).
    existing.accumulator.reset()
    this.deps.logger.info('audio detached', {
      tags: { deviceId },
      meta: { brokerId: existing.brokerId, reason },
    })
    return true
  }
}
