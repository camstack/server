/**
 * The stream outage a DEVICE is in — one record per device, however many of its
 * profiles dropped (D883).
 *
 * The health sweep judges brokers one by one, but an outage is a fact about the
 * camera: main and sub of one camera losing their stream together is ONE
 * thing, and the operator's phone must ring once. This holds the device-level
 * state the per-broker sweep folds into: which reason opened it, which streams
 * it covers, and whether the offline event for it has been sent yet.
 */

import type { BatteryPresence } from '@camstack/types'
import {
  STREAM_STALE_TIMEOUT_MS,
  type StaleStreamVerdict,
  type StreamOutageReason,
} from './stream-health-policy.js'

export interface DeviceOutage {
  readonly reason: StreamOutageReason
  readonly since: number
  /** Streams covered, in the order they dropped. */
  readonly camStreamIds: Set<string>
  /** Has the single `stream.offline` for this outage been emitted? */
  announced: boolean
  /**
   * Opened by a failed wake-on-play, with no broker of its own carrying it.
   * It closes on the next healthy flip, or when the failures stop (demand gone).
   */
  wakeOnly: boolean
  /** The last time something confirmed this outage (a failed wake, a quiet sweep). */
  lastSignalAt: number
  /**
   * A `connection-error` the stale window has not already covered. It is
   * announced only once it has lasted that window, and cancelled with no
   * event if any source of the camera delivers before then.
   */
  held: boolean
  /** The hold has been logged. One line, not one per sweep. */
  holdNoted: boolean
}

export class DeviceStreamOutages {
  private readonly byDevice = new Map<number, DeviceOutage>()

  get(deviceId: number): DeviceOutage | undefined {
    return this.byDevice.get(deviceId)
  }

  /** Open the device's outage, or add this stream to the one already open. */
  open(
    deviceId: number,
    camStreamId: string,
    reason: StreamOutageReason,
    now: number,
    held: boolean,
  ): DeviceOutage {
    const existing = this.byDevice.get(deviceId)
    if (existing) {
      existing.camStreamIds.add(camStreamId)
      existing.wakeOnly = false
      existing.lastSignalAt = now
      // A stream that has already sat out the stale window joins a hold and
      // ends it: the camera has been down long enough.
      if (!held) existing.held = false
      return existing
    }
    const created: DeviceOutage = {
      reason,
      since: now,
      camStreamIds: new Set([camStreamId]),
      announced: false,
      wakeOnly: false,
      lastSignalAt: now,
      held,
      holdNoted: false,
    }
    this.byDevice.set(deviceId, created)
    return created
  }

  /**
   * A failed wake with no broker to carry it. Joins the device's open outage
   * (one outage per device) or opens a wake-only one over its REAL streams.
   */
  openWake(
    deviceId: number,
    camStreamIds: readonly string[],
    reason: StreamOutageReason,
    now: number,
  ): DeviceOutage {
    const existing = this.byDevice.get(deviceId)
    if (existing) {
      existing.lastSignalAt = now
      return existing
    }
    const created: DeviceOutage = {
      reason,
      since: now,
      camStreamIds: new Set(camStreamIds),
      announced: false,
      wakeOnly: true,
      lastSignalAt: now,
      held: false,
      holdNoted: false,
    }
    this.byDevice.set(deviceId, created)
    return created
  }

  entries(): IterableIterator<[number, DeviceOutage]> {
    return this.byDevice.entries()
  }

  close(deviceId: number): void {
    this.byDevice.delete(deviceId)
  }

  clear(): void {
    this.byDevice.clear()
  }
}

/**
 * What the sweep does with a `connection-error` that has not been announced.
 *
 * A delivering camera cancels it. Inside the sustained window it stays held.
 * Once that window has elapsed, a battery re-judge of `suppressed` (asleep, or
 * still inside the wake bound) drops the hold; any other verdict, including
 * facts that were never read, is announced.
 */
export type ConnectionErrorHoldDecision =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'hold' }
  | { readonly kind: 'announce' }
  | { readonly kind: 'drop-asleep'; readonly presence: BatteryPresence }

export interface ConnectionErrorHoldInput {
  readonly outage: DeviceOutage
  readonly now: number
  readonly delivering: boolean
  /**
   * Battery re-judge once the hold has lasted the sustained window.
   * `null` before that, or when the sleep mirror was never read.
   */
  readonly promotionVerdict: StaleStreamVerdict | null
}

export function decideConnectionErrorHold(
  input: ConnectionErrorHoldInput,
): ConnectionErrorHoldDecision {
  if (input.delivering) return { kind: 'cancel' }
  if (input.outage.held && input.now - input.outage.since < STREAM_STALE_TIMEOUT_MS) {
    return { kind: 'hold' }
  }
  if (input.outage.held && input.promotionVerdict?.kind === 'suppressed') {
    return { kind: 'drop-asleep', presence: input.promotionVerdict.presence }
  }
  return { kind: 'announce' }
}
