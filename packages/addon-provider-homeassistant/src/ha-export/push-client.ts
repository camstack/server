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
    try {
      await this.transport(message)
      this.onReachable()
      return true
    } catch (err) {
      this.onUnreachable(message, err)
      return false
    }
  }

  private onReachable(): void {
    if (this.available) return
    this.available = true
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
    this.dropped += message.type === 'batch' ? message.items.length : 1
    const now = Date.now()
    if (now - this.droppedLoggedAt < DROP_LOG_INTERVAL_MS) return
    this.droppedLoggedAt = now
    this.logger.warn('ha-export: push to Home Assistant failed, messages dropped', {
      meta: {
        brokerId: this.brokerId,
        dropped: this.dropped,
        messageType: message.type,
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }
}
