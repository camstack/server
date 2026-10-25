/**
 * `AudioChunkPoller` — the consumer-side poll loop of the decoded audio-chunk
 * plane (Phase 5 / D9).
 *
 * Replaces the live-object `IStreamBroker.onDecodedAudioChunk(cb)` callback
 * path. A live callback cannot cross a process boundary, so audio delivery
 * goes over tRPC.
 *
 * ## Who runs this loop (D461)
 *
 * The orchestrator did, until 2026-09-11, and that was an accident of the
 * boundary redraw rather than a decision: the code had been a closure INSIDE
 * the broker's process, and when `pipeline` was dissolved it was left where it
 * sat. The orchestrator neither produced nor consumed the audio. It now runs
 * inside `audio-analyzer`, next to the classifier that needs the samples, and
 * the two legs the relay used to add (orchestrator → hub-main → analyzer,
 * ~49 MB/min each because the expansion happened before the forward) are gone.
 *
 * The poll therefore lands on whichever boundary separates the analyzer from
 * the broker: UDS through hub-main when they share a node, the Moleculer mesh
 * when the orchestrator dispatched this camera's analysis elsewhere. That is
 * why {@link AudioChunkPollerOptions.pollIntervalMs} exists — the poll RATE is
 * now a property of the boundary it crosses, and it was not before.
 *
 * The consumer:
 *
 *   1. `subscribeAudioChunks({ brokerId, tag })` over tRPC — the broker
 *      registers a per-subscription bounded FIFO queue and returns a
 *      `subscriptionId`;
 *   2. polls `pullAudioChunks({ subscriptionId, maxCount })` on a modest
 *      interval, draining `DecodedAudioChunk`s in FIFO arrival order;
 *   3. feeds each chunk to its downstream audio logic;
 *   4. on teardown, `unsubscribeAudioChunks`.
 *
 * Audio is not latency-critical like video, but the chunk cadence is NOT one
 * number and this docblock used to claim it was ("~every 500ms, the broker's
 * `AudioCodecSession` window"). That window was removed so WebRTC could have
 * sub-100 ms decode latency: the AAC path now emits one chunk per codec frame,
 * ~42 ms. The poll period is therefore bounded by {@link PULL_MAX_COUNT}
 * against the PRODUCER, not chosen against the boundary — see D465, and see
 * the continuation in `startPolling` that makes it safe for a producer this
 * file cannot know about.
 *
 * Boot-race tolerance: the broker for a given camStream may not be registered
 * yet when the orchestrator wires the subscription (provider addons publish
 * their cameraStreams asynchronously after their probe completes).
 * `subscribeAudioChunks` retries with exponential backoff (capped at
 * `MAX_SUBSCRIBE_RETRY_BACKOFF_MS`) until it succeeds or the returned
 * teardown closure is invoked. Mirrors the `FrameHandlePoller` recovery
 * shape so video and audio plumbing self-heal identically.
 */
import { errMsg, nodePin } from '@camstack/types'
import type {
  AddonApi,
  AudioChunkFormat,
  DecodedAudioChunkWire,
  IScopedLogger,
} from '@camstack/types'

/**
 * Poll period when the broker is on the SAME node — audio chunks arrive
 * ~every 500ms and 200ms keeps latency low. This is what the orchestrator
 * always used, and on a hub-local analyzer it is unchanged.
 */
export const LOCAL_POLL_INTERVAL_MS = 200

/**
 * Poll period when the broker is on ANOTHER node.
 *
 * The relay removal moves the poll loop to the consumer's side (D461), so for
 * a camera whose analysis was dispatched to an agent the poll now crosses the
 * Moleculer mesh instead of hub-main's UDS. At 200 ms that is 5 requests per
 * second per camera on the mesh where the relay used to put one — the bytes
 * collapse 8x (coded, one crossing instead of two) but the REQUEST rate would
 * have gone the wrong way, and D448 measured the plane's envelope handling as
 * a real cost, not a rounding error. 500 ms matches the chunk cadence: the
 * FIFO holds ~30 s and `PULL_MAX_COUNT` drains 8 at a time, so a poll per
 * chunk loses nothing and costs at most 300 ms of added latency against a
 * ~1 s window and a 90 s watchdog threshold.
 */
export const REMOTE_POLL_INTERVAL_MS = 500

/**
 * How many chunks to drain per poll (D465).
 *
 * This number, not the poll interval, is what bounds the cadence. A poll must
 * be able to carry everything the PRODUCER made since the last one, and the
 * producer is not one thing: `AudioRtpDecoder` buffers native G.711 into
 * ~500 ms chunks, while `AudioCodecSession` emits one chunk per decoded AAC
 * frame — ~42 ms on this fleet, deliberately, because the accumulator was
 * removed to give WebRTC sub-100 ms latency. D461 chose
 * {@link REMOTE_POLL_INTERVAL_MS} = 500 reasoning "one poll per chunk", which
 * is true of the first producer and wrong by 12x for the second: at a batch of
 * 8 a remote AAC camera fell ~4 chunks further behind every poll, filled the
 * broker's 64-deep FIFO in ~15 s, and then lost audio for as long as it stayed
 * dispatched. 32 covers 500 ms of a 21 ms-frame codec with margin.
 */
export const PULL_MAX_COUNT = 32

/**
 * How many times one tick may re-poll immediately after a FULL batch (D465).
 *
 * A batch that comes back full is not a drain, it is a backlog: there is more
 * waiting and the next chunk is already older than the window it belongs to.
 * Continuing bounds the damage for any producer cadence — including one this
 * file cannot know — without adding a single request when there is no backlog.
 * The broker's FIFO holds 64, so two continuations clear a completely full
 * queue; four is margin, and the bound is what stops a permanently faster
 * producer from turning this into a spin.
 */
const MAX_DRAIN_CONTINUATIONS = 4

/** Re-state a standing backlog at most this often. */
const BACKLOG_RELOG_MS = 30_000

/**
 * Consecutive pull failures before we attempt to re-subscribe. A single failed
 * poll is treated as a blip (re-subscribing would leak a broker-side FIFO); a
 * sustained failure means the broker child restarted and dropped our
 * subscription, so we re-establish it.
 */
const RESUBSCRIBE_AFTER_FAILURES = 2

/** Re-subscribe at most once every N ticks while failing (~1s at 200ms). */
const RESUBSCRIBE_THROTTLE_TICKS = 5

/** First subscribe-retry delay, doubled on every subsequent failure. */
const INITIAL_SUBSCRIBE_RETRY_BACKOFF_MS = 250

/**
 * Subscribe-retry backoff ceiling. 5 s matches the frame-handle poller — fast
 * enough to recover within a single reconcile of the orchestrator and slow
 * enough that a misconfigured camStream costs ~12 op/min, not 5/s.
 */
const MAX_SUBSCRIBE_RETRY_BACKOFF_MS = 5_000

/**
 * Attempts after which a still-failing subscribe escalates from the fast 5 s
 * ceiling to {@link LONG_SUBSCRIBE_RETRY_BACKOFF_MS}. ~15 attempts ≈ one
 * minute of fast retries — plenty for the boot races the 5 s ceiling exists
 * for. A broker that is STILL absent after that is a long-lived condition
 * (e.g. a DISABLED camera, whose broker the stream-broker reconcile refuses
 * to recreate — 2026-07-23) and retrying every 5 s forever is pure log/RPC
 * churn. The slow loop stays alive so audio still recovers automatically
 * (≤60 s) once the camera is re-enabled.
 */
const PERSISTENT_SUBSCRIBE_FAILURE_ATTEMPTS = 15
const LONG_SUBSCRIBE_RETRY_BACKOFF_MS = 60_000

/** Inputs for a single audio-chunk subscription. */
export interface AudioChunkPollerOptions {
  /** The cross-addon API surface — audio chunks travel over `streamBroker`. */
  readonly api: AddonApi
  /** Broker id (`<deviceId>/<streamId>`) to subscribe to. */
  readonly brokerId: string
  /** Short caller-identity tag for broker-side diagnostics. */
  readonly tag: string
  /**
   * Cluster node that owns the source acquisition for this camera
   * (`clusterRoles.ingestNode`). Every `streamBroker` call this poller makes
   * is pinned to this node via `nodePin` — subscribe/pull/unsubscribe are
   * pure RPC, so no hostname is needed, only the pin.
   */
  readonly ownerNodeId: string
  /**
   * Byte formats the CONSUMER OF THIS POLLER can read (D455). Passed to the
   * broker on every subscribe, including the re-subscribe after an outage —
   * a recovery that forgot it would quietly put the leg back on four bytes
   * per sample and nothing downstream would look any different.
   *
   * Omitted means f32le, which is what every subscriber got before this
   * existed. The declaration belongs to whoever OWNS the bytes after the
   * poller hands them over, which is why it is a parameter and not a
   * constant: this poller does not interpret a single sample.
   */
  readonly accept?: readonly AudioChunkFormat[]
  /**
   * Steady-state poll period. Defaults to {@link LOCAL_POLL_INTERVAL_MS} —
   * the caller picks {@link REMOTE_POLL_INTERVAL_MS} when `ownerNodeId` is not
   * its own node, because the loop then crosses the mesh rather than hub-main.
   */
  readonly pollIntervalMs?: number
  /** Called for every drained chunk, in FIFO arrival order. */
  readonly onChunk: (chunk: DecodedAudioChunkWire) => void | Promise<void>
  readonly logger: IScopedLogger
}

interface Lifecycle {
  stopped: boolean
  retryTimer: ReturnType<typeof setTimeout> | undefined
  pollTimer: ReturnType<typeof setTimeout> | undefined
  activeSubscriptionId: string | null
  /** True while ticks keep needing a continuation — the line fires per EPISODE. */
  backlogged: boolean
  /** Ms epoch of the last backlog line, for the re-log throttle. */
  lastBacklogLogAt: number
}

/**
 * Subscribe to a broker's decoded audio-chunk stream and start the poll loop.
 *
 * Always resolves to a teardown closure — when the broker is not yet
 * registered the closure cancels the ongoing retry loop; when polling is
 * active it stops the loop and releases the broker subscription. Mirrors
 * `startFrameHandlePoller` so video and audio recover identically.
 */
export function startAudioChunkPoller(options: AudioChunkPollerOptions): () => void {
  const lifecycle: Lifecycle = {
    stopped: false,
    retryTimer: undefined,
    pollTimer: undefined,
    activeSubscriptionId: null,
    backlogged: false,
    lastBacklogLogAt: 0,
  }

  const teardown = (): void => {
    if (lifecycle.stopped) return
    lifecycle.stopped = true
    if (lifecycle.retryTimer) {
      clearTimeout(lifecycle.retryTimer)
      lifecycle.retryTimer = undefined
    }
    if (lifecycle.pollTimer) {
      clearTimeout(lifecycle.pollTimer)
      lifecycle.pollTimer = undefined
    }
    const subId = lifecycle.activeSubscriptionId
    if (subId) {
      lifecycle.activeSubscriptionId = null
      options.api.streamBroker.unsubscribeAudioChunks
        .mutate({ subscriptionId: subId }, nodePin(options.ownerNodeId))
        .catch((err: unknown) => {
          options.logger.warn('audio-chunk poller: unsubscribeAudioChunks failed', {
            meta: { brokerId: options.brokerId, subscriptionId: subId, error: errMsg(err) },
          })
        })
    }
  }

  void subscribeWithRetry(options, lifecycle)
  return teardown
}

/**
 * Run the subscribe → poll handshake with exponential backoff on subscribe
 * failures. Resolves once the subscription is acquired (and the poll loop has
 * been started) or once `lifecycle.stopped` flips, whichever comes first.
 */
async function subscribeWithRetry(
  options: AudioChunkPollerOptions,
  lifecycle: Lifecycle,
): Promise<void> {
  const { api, brokerId, tag, ownerNodeId, logger } = options
  const pin = nodePin(ownerNodeId)
  let backoffMs = INITIAL_SUBSCRIBE_RETRY_BACKOFF_MS
  let attempt = 0

  while (!lifecycle.stopped) {
    attempt += 1
    try {
      const result = await api.streamBroker.subscribeAudioChunks.mutate(
        {
          brokerId,
          tag,
          ...(options.accept ? { accept: options.accept } : {}),
        },
        pin,
      )
      if (lifecycle.stopped) {
        // The caller tore the poller down while subscribe was in flight —
        // release the subscription we just acquired so the broker doesn't
        // leak the per-sub FIFO.
        await api.streamBroker.unsubscribeAudioChunks
          .mutate({ subscriptionId: result.subscriptionId }, pin)
          .catch((err: unknown) => {
            logger.warn('audio-chunk poller: late unsubscribe failed', {
              meta: { brokerId, subscriptionId: result.subscriptionId, error: errMsg(err) },
            })
          })
        return
      }
      if (attempt > 1) {
        logger.info('audio-chunk poller: subscribeAudioChunks recovered', {
          meta: { brokerId, tag, attempt },
        })
      }
      lifecycle.activeSubscriptionId = result.subscriptionId
      startPolling(options, lifecycle)
      return
    } catch (err) {
      if (lifecycle.stopped) return
      // First attempt logs at `warn` to surface boot races on a fresh hub;
      // subsequent retries drop to `debug` so a missing broker doesn't spam
      // the log at INFO/WARN forever.
      if (attempt === 1) {
        logger.warn('audio-chunk poller: subscribeAudioChunks failed, retrying', {
          meta: { brokerId, tag, error: errMsg(err), nextRetryInMs: backoffMs },
        })
      } else {
        logger.debug('audio-chunk poller: subscribeAudioChunks still failing', {
          meta: { brokerId, tag, attempt, error: errMsg(err), nextRetryInMs: backoffMs },
        })
      }
      // The moment a boot race becomes a CONDITION, said once, at a level the
      // hub actually writes. Everything between the first attempt and here is
      // at `debug`, which does not exist on the hub (D438) — so before D461
      // a camera whose audio never attached produced exactly one WARN at
      // t+0 and then nothing, forever. That mattered less while the
      // orchestrator held the poller and its watchdog tap sat on the chunk;
      // now the poller is in another process and this line is the only thing
      // between "no audio" and a silent, permanent gap (D427).
      if (attempt === PERSISTENT_SUBSCRIBE_FAILURE_ATTEMPTS) {
        logger.warn('audio-chunk poller: broker still absent after a minute — slowing the retry', {
          meta: {
            brokerId,
            tag,
            attempt,
            error: errMsg(err),
            nextRetryInMs: LONG_SUBSCRIBE_RETRY_BACKOFF_MS,
            hint: 'a DISABLED camera, or a camStreamId the broker never registered — audio stays absent until the broker appears',
          },
        })
      }
      await sleep(backoffMs, lifecycle)
      const ceiling =
        attempt >= PERSISTENT_SUBSCRIBE_FAILURE_ATTEMPTS
          ? LONG_SUBSCRIBE_RETRY_BACKOFF_MS
          : MAX_SUBSCRIBE_RETRY_BACKOFF_MS
      backoffMs = Math.min(ceiling, backoffMs * 2)
    }
  }
}

/**
 * Drive the steady-state poll loop. Mid-stream `pullAudioChunks` failures
 * trigger a fresh `subscribeAudioChunks` via the recovery branch — covers
 * the broker child restart case where our `subscriptionId` is silently
 * disowned.
 */
function startPolling(options: AudioChunkPollerOptions, lifecycle: Lifecycle): void {
  const { api, brokerId, tag, ownerNodeId, onChunk, logger } = options
  const pin = nodePin(ownerNodeId)
  let consecutiveFailures = 0

  const resubscribe = async (): Promise<boolean> => {
    try {
      const result = await api.streamBroker.subscribeAudioChunks.mutate(
        { brokerId, tag, ...(options.accept ? { accept: options.accept } : {}) },
        pin,
      )
      lifecycle.activeSubscriptionId = result.subscriptionId
      logger.info('audio-chunk poller: re-subscribed after broker outage', {
        meta: {
          brokerId,
          tag,
          subscriptionId: result.subscriptionId,
          afterFailures: consecutiveFailures,
        },
      })
      return true
    } catch {
      return false
    }
  }

  const tick = async (): Promise<void> => {
    if (lifecycle.stopped) return
    const subId = lifecycle.activeSubscriptionId
    if (!subId) return
    try {
      let continuations = 0
      let drained = 0
      // Drain while the broker keeps handing back a FULL batch: see
      // MAX_DRAIN_CONTINUATIONS. The common case is one iteration and one
      // request, exactly as before.
      for (;;) {
        const chunks = await api.streamBroker.pullAudioChunks.query(
          {
            subscriptionId: subId,
            maxCount: PULL_MAX_COUNT,
          },
          pin,
        )
        if (consecutiveFailures > 0) {
          logger.info('audio-chunk poller: stream recovered', {
            meta: { brokerId, subscriptionId: subId },
          })
        }
        consecutiveFailures = 0
        drained += chunks.length
        for (const chunk of chunks) {
          if (lifecycle.stopped) break
          await onChunk(chunk)
        }
        if (lifecycle.stopped) break
        if (chunks.length < PULL_MAX_COUNT) break
        if (continuations >= MAX_DRAIN_CONTINUATIONS) break
        continuations += 1
      }
      if (continuations > 0) {
        // A branch that ACCEPTS work and only just keeps up is the one that
        // silently stops keeping up. Say it, per camera, or the first evidence
        // is an audio gap nobody can date.
        const now = Date.now()
        if (!lifecycle.backlogged || now - lifecycle.lastBacklogLogAt >= BACKLOG_RELOG_MS) {
          lifecycle.lastBacklogLogAt = now
          logger.warn('audio-chunk poller: backlog — a full batch is not a drain', {
            meta: {
              brokerId,
              subscriptionId: subId,
              drained,
              maxCount: PULL_MAX_COUNT,
              continuations,
              pollIntervalMs: options.pollIntervalMs ?? LOCAL_POLL_INTERVAL_MS,
              hint: 'this camera produces chunks faster than one poll of this cadence can carry — the broker FIFO is overwriting next',
            },
          })
        }
        lifecycle.backlogged = true
      } else {
        lifecycle.backlogged = false
      }
    } catch (err: unknown) {
      consecutiveFailures += 1
      if (consecutiveFailures === 1) {
        logger.warn('audio-chunk poller: pullAudioChunks failed — attempting recovery', {
          meta: { brokerId, subscriptionId: subId, error: errMsg(err) },
        })
      }
      if (
        !lifecycle.stopped &&
        consecutiveFailures >= RESUBSCRIBE_AFTER_FAILURES &&
        (consecutiveFailures - RESUBSCRIBE_AFTER_FAILURES) % RESUBSCRIBE_THROTTLE_TICKS === 0
      ) {
        await resubscribe()
      }
    }
    if (!lifecycle.stopped) {
      lifecycle.pollTimer = setTimeout(
        () => void tick(),
        options.pollIntervalMs ?? LOCAL_POLL_INTERVAL_MS,
      )
    }
  }

  // Run the first poll immediately so the consumer is not blind for a full
  // poll interval. `tick` self-schedules every later poll; its `stopped`
  // guard means a teardown firing before/just after this first tick still
  // stops the loop cleanly.
  void tick()
}

/**
 * Cancellable sleep — wakes early when `lifecycle.stopped` flips. We
 * keep a local wrapper around the shared {@link sleep} helper because
 * the lifecycle tracks the active retry timer for `teardown()` to
 * clear; pure `sleep()` would leak the timer if teardown fired while
 * we were waiting.
 */
function sleep(ms: number, lifecycle: Lifecycle): Promise<void> {
  return new Promise<void>((resolve) => {
    if (lifecycle.stopped) {
      resolve()
      return
    }
    lifecycle.retryTimer = setTimeout(() => {
      lifecycle.retryTimer = undefined
      resolve()
    }, ms)
  })
}
