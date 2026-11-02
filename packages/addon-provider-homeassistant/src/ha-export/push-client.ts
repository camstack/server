/**
 * The only module that speaks HTTP to Home Assistant.
 *
 * Three properties from the reference implementation are load-bearing
 * rather than incidental, and all three are here:
 *
 *   - **batching** — state updates accumulate into one POST. Only
 *     `entity_change` goes alone and immediately, because it changes
 *     structure rather than value.
 *   - **heartbeat** — a periodic POST that doubles as the availability
 *     signal. When it stops the component marks every entity
 *     unavailable. One source of truth for "camstack is alive".
 *   - **per-topic dedup** — a value is sent only when it changed. Across
 *     ~880 entities this is the difference between an installation and a
 *     storm.
 *
 * One deliberate DIVERGENCE from the reference: its dedup cache is never
 * invalidated, not on reconnect and not on a 401, so an HA that lost its
 * state buffer stayed blank until each value happened to change. Here the
 * cache is dropped the moment the link comes back.
 *
 * Dropping it is only HALF a recovery, and shipping only that half was a
 * real defect: the sender had forgotten what it sent (correct) but
 * re-sent nothing, so Home Assistant stayed blank until the periodic
 * reconcile — 300s by default. `onLinkRestored` is the other half; the
 * addon answers it with a full re-announce, bounded by
 * `ReachabilityReconciler`.
 */
import type { IScopedLogger } from '@camstack/types'
import { describePushFailure, type PushFailure, PushHttpError } from './push-failure.js'
import type { HaCmps, HaDeviceBlock, PushMessage, StateUpdateMessage } from './types.js'

/** How long state updates accumulate before one POST carries them all. */
export const BATCH_FLUSH_MS = 1_000

/** Availability cadence. The component's timeout is a multiple of this. */
export const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Above this, a value collapses to a signal.
 *
 * Images never cross the transport: camstack pushes a signed, expiring
 * URL that HA fetches on demand. This bound is the backstop for anything
 * else that grows unexpectedly — an attribute blob, a long label list —
 * so one oversized value cannot become a multi-megabyte POST.
 */
export const MAX_VALUE_CHARS = 2_048

export const IMAGE_SIGNAL_PREFIX = '__image_updated__:'

/** Sends one message. Injected so the batching logic is testable. */
export type PushTransport = (message: PushMessage) => Promise<void>

/** The subset of the injected logger this module uses. */
export type PushLogger = Pick<IScopedLogger, 'debug' | 'info' | 'warn'>

export interface PushClientOptions {
  readonly transport: PushTransport
  readonly logger: PushLogger
  /** Identifies the target HA instance in every log line. */
  readonly brokerId: string
  /**
   * The link came back, and the dedup cache has ALREADY been dropped.
   *
   * Clearing the cache is only half a recovery: it stops the sender
   * suppressing values, but nothing re-sends them. Without this signal
   * the next full push is the periodic reconcile — 300s by default — and
   * every entity in Home Assistant sits blank until then. The addon
   * answers it with a full re-announce, bounded by
   * `ReachabilityReconciler`.
   */
  readonly onLinkRestored?: (brokerId: string) => void
}

/**
 * How long a permanent failure (a missing component) is left alone before the
 * next probe. A 404 does not heal by retrying; it heals when the operator
 * installs the component, which the settings-change reset picks up at once.
 */
export const COMPONENT_RECHECK_MS = 10 * 60_000

/**
 * How long 404s must persist, unbroken, before the component counts as
 * missing. Home Assistant answers HTTP before the integration has registered
 * its push view, so a restart produces a 404 window that heals itself; only a
 * 404 that outlives it is a component that is not installed.
 */
export const COMPONENT_MISSING_WINDOW_MS = 60_000

/** Rate limit for the "HA is not answering" warning. */
const DROP_LOG_INTERVAL_MS = 30_000

export class PushClient {
  private readonly transport: PushTransport
  private readonly logger: PushLogger
  private readonly brokerId: string
  private readonly onLinkRestored: ((brokerId: string) => void) | undefined

  /** topic → last value SENT. Dropped whenever the link is lost. */
  private readonly stateCache = new Map<string, string>()
  private buffer: StateUpdateMessage[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private available = true
  private dropped = 0
  private droppedLoggedAt = 0
  private disposed = false
  private lastFailure: PushFailure | null = null
  private suspendedUntil = 0
  /** When the current unbroken streak of 404s began; 0 when there is none. */
  private first404At = 0
  /** A suspension was entered and not yet logged as left. */
  private suspensionLogged = false

  constructor(options: PushClientOptions) {
    this.transport = options.transport
    this.logger = options.logger
    this.brokerId = options.brokerId
    this.onLinkRestored = options.onLinkRestored
  }

  /** `false` once a POST has failed, `true` again on the next success. */
  get healthy(): boolean {
    return this.available
  }

  /** Why the last push failed; `null` while the link is healthy. */
  get failure(): PushFailure | null {
    return this.lastFailure
  }

  /** A permanent failure is being left alone until the next probe. */
  get suspended(): boolean {
    return this.suspendedUntil > Date.now()
  }

  /** Epoch ms of the next probe while suspended; 0 otherwise. */
  get recheckAt(): number {
    return this.suspended ? this.suspendedUntil : 0
  }

  /** Probe again at once — the operator changed something. */
  resetBackoff(): void {
    this.suspendedUntil = 0
    this.first404At = 0
    this.logSuspensionEnded('reset by a settings change')
  }

  private logSuspensionEnded(why: string): void {
    if (!this.suspensionLogged) return
    this.suspensionLogged = false
    this.logger.info(`ha-export: push link no longer suspended (${why}), probing again`, {
      meta: { brokerId: this.brokerId },
    })
  }

  /** Messages discarded because HA did not answer. Never silent. */
  get droppedCount(): number {
    return this.dropped
  }

  start(): void {
    if (this.heartbeatTimer !== null) return
    this.heartbeatTimer = setInterval(() => {
      void this.send({ type: 'heartbeat', ts: Date.now() })
    }, HEARTBEAT_INTERVAL_MS)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.buffer = []
  }

  /**
   * Queue one state value.
   *
   * Deduped per topic, so a camera reporting `online: true` every five
   * seconds costs nothing after the first.
   */
  publishState(topic: string, value: string): void {
    if (this.disposed) return
    const payload = value.length > MAX_VALUE_CHARS ? `${IMAGE_SIGNAL_PREFIX}${Date.now()}` : value
    if (this.stateCache.get(topic) === payload) return
    this.stateCache.set(topic, payload)
    this.buffer.push({ type: 'state_update', topic, value: payload })
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => void this.flush(), BATCH_FLUSH_MS)
    }
  }

  /**
   * Announce a device's COMPLETE component set.
   *
   * Never a delta, and re-sent in full on reconnect: an event is
   * telemetry and may be dropped (D8), so a lost structure message must
   * not be able to leave HA with half a device. The pending state batch
   * is flushed first — a value for an entity HA has not built yet is a
   * value it discards.
   */
  async publishEntityChange(
    deviceKey: string,
    cmps: HaCmps,
    dev: HaDeviceBlock,
    full = false,
  ): Promise<boolean> {
    if (this.disposed) return false
    await this.flush()
    return this.send({
      type: 'entity_change',
      device_id: deviceKey,
      cmps,
      dev,
      ...(full ? { full: true as const } : {}),
    })
  }

  /** Send everything buffered now. Called before any structure change. */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.buffer.length === 0) return
    const items = this.buffer
    this.buffer = []
    await this.send({ type: 'batch', items })
  }

  /** `true` when Home Assistant took the message. */
  private async send(message: PushMessage): Promise<boolean> {
    if (this.suspended) {
      this.dropped += message.type === 'batch' ? message.items.length : 1
      return false
    }
    if (this.suspendedUntil !== 0 && !this.suspended) {
      this.suspendedUntil = 0
      this.logSuspensionEnded('recheck time reached')
    }
    try {
      await this.transport(message)
      this.first404At = 0
      this.onReachable()
      return true
    } catch (err) {
      if (err instanceof PushHttpError && err.status === 413 && message.type === 'batch') {
        const half = Math.ceil(message.items.length / 2)
        if (message.items.length > 1) {
          // Too large as one body: halve it until each part lands. Bounded —
          // every level halves, and a single item that is still refused is
          // dropped like any other failure.
          const first = await this.send({ type: 'batch', items: message.items.slice(0, half) })
          const second = await this.send({ type: 'batch', items: message.items.slice(half) })
          return first && second
        }
      }
      this.onUnreachable(message, err)
      return false
    }
  }

  private onReachable(): void {
    if (this.available) return
    this.available = true
    this.lastFailure = null
    this.suspendedUntil = 0
    this.logSuspensionEnded('Home Assistant answered')
    /**
     * The link came back. Drop the dedup cache so the reconcile that
     * follows re-pushes every value: HA may have restarted and lost its
     * state, and a cache that still remembers the old value would
     * suppress exactly the messages needed to repair it.
     */
    this.stateCache.clear()
    this.logger.info('ha-export: Home Assistant reachable again, state cache cleared', {
      meta: { brokerId: this.brokerId, droppedWhileDown: this.dropped },
    })
    this.dropped = 0
    this.droppedLoggedAt = 0
    /**
     * Signalled AFTER the cache is gone and BEFORE anything else is sent:
     * the handler re-announces from inside this call, and a cache that
     * still held the old values would dedup away exactly those messages.
     * The handler's own failure is its business — it can never take the
     * transport, or the runner, down with it (D29).
     */
    try {
      this.onLinkRestored?.(this.brokerId)
    } catch (err) {
      this.logger.warn('ha-export: the re-announce handler threw, link is up but not repaired', {
        meta: { brokerId: this.brokerId, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * A failed POST discards work, so it may not be silent — an operator
   * whose entities froze two days ago needs the log to say camstack is
   * pushing into a wall, not merely that the addon is "running". Rate
   * limited, because the alternative is a storm that buries the line.
   */
  private onUnreachable(message: PushMessage, err: unknown): void {
    this.available = false
    const now = Date.now()
    const described = describePushFailure(err)
    let failure = described
    if (described.kind === 'component-missing') {
      if (this.first404At === 0) this.first404At = now
      if (now - this.first404At < COMPONENT_MISSING_WINDOW_MS) {
        // Home Assistant may still be booting: treat as transient and retry
        // on the normal schedule until the 404 has persisted.
        failure = {
          kind: 'other',
          permanent: false,
          text: 'HTTP 404 — Home Assistant has not registered the CamStack endpoint (yet); retrying',
        }
      }
    } else {
      this.first404At = 0
    }
    this.lastFailure = failure
    this.dropped += message.type === 'batch' ? message.items.length : 1
    if (failure.permanent) {
      this.suspendedUntil = now + COMPONENT_RECHECK_MS
      this.suspensionLogged = true
      // Outside the drop rate limit: entering suspension is the one line that
      // explains every silent drop that follows.
      this.logger.warn(
        `ha-export: push link SUSPENDED (${failure.text}); next probe at ${new Date(this.suspendedUntil).toISOString()}`,
        {
          meta: {
            brokerId: this.brokerId,
            failureKind: failure.kind,
            recheckAt: this.suspendedUntil,
            recheckInMs: COMPONENT_RECHECK_MS,
          },
        },
      )
    }
    if (now - this.droppedLoggedAt < DROP_LOG_INTERVAL_MS) return
    this.droppedLoggedAt = now
    this.logger.warn(
      `ha-export: push to Home Assistant failed (${failure.text}), messages dropped`,
      {
        meta: {
          brokerId: this.brokerId,
          dropped: this.dropped,
          messageType: message.type,
          failureKind: failure.kind,
          error: err instanceof Error ? err.message : String(err),
        },
      },
    )
  }
}
