/**
 * WHAT a stale stream means for a battery camera (D883).
 *
 * A mains camera whose stream goes quiet for the stale window has lost its
 * stream: that is an outage. A battery camera whose stream goes quiet has,
 * ordinarily, gone to sleep — the designed steady state, not a fault. The
 * broker used to tell the two apart by nothing, so every sleep produced a
 * `stream.offline` per profile and every wake a `stream.online`, and the
 * operator's system-event rule pushed each one.
 *
 * The verdict is made HERE, at the emitter, from the battery's own sleep
 * mirror — never by a filter downstream:
 *
 *  - asleep and nobody asked for the stream — NOT an outage (`asleep`);
 *  - asleep, a stream was DEMANDED and none arrived — `wake-timeout`;
 *  - reported awake, the stream is gone, and the camera has been awake longer
 *    than a wake needs (`WAKE_DEMAND_BOUND_MS`) — `connection-error`; inside
 *    that window it is the normal wake (sleeping flipped, first keyframe not
 *    yet here) and is suppressed, then re-judged;
 *  - silent past the battery refresh window — `battery-unreachable`.
 *
 * A sleep verdict needs a sleep state that was actually READ. A mirror that
 * was never fed (a restart, a dropped event) is not "asleep": the caller passes
 * `battery: null` and the stream is judged exactly as a mains one (D49 —
 * unknown excludes nothing, and a silent suppression on an unread mirror hid
 * a camera that slept and then died).
 */

import {
  deriveBatteryPresence,
  type BatteryPresence,
  type StreamHealthReason,
} from '@camstack/types'

/** The reasons that ARE an outage — the only `stream.offline` a consumer acts on. */
export type StreamOutageReason = Extract<
  StreamHealthReason,
  'stale-timeout' | 'wake-timeout' | 'connection-error' | 'battery-unreachable'
>

const OUTAGE_REASONS: readonly StreamHealthReason[] = [
  'stale-timeout',
  'wake-timeout',
  'connection-error',
  'battery-unreachable',
]

/**
 * How long a demand may wait for a sleeping camera's stream before it counts
 * as a failed wake: the firmware wake bound plus the broker settle window of
 * wake-on-play (8 s + 20 s), with margin for the sweep cadence.
 */
export const WAKE_DEMAND_BOUND_MS = 45_000

export function isStreamOutageReason(
  reason: StreamHealthReason | undefined,
): reason is StreamOutageReason {
  return reason !== undefined && OUTAGE_REASONS.includes(reason)
}

/** The battery sleep mirror's facts for one device. */
export interface BatterySleepFacts {
  readonly sleeping: boolean
  readonly lastContactAt?: number
  /**
   * Epoch ms when `sleeping` last flipped to false, as the broker saw it.
   * Unknown (a restart, a slice read of an already-awake camera) = judged as
   * awake for long enough: today's immediate `connection-error`, never a
   * silent suppression on a fact nobody observed (D49).
   */
  readonly awakeSince?: number
}

export interface StaleStreamInput {
  /**
   * `null` = a mains camera, OR a battery camera whose sleep state was never
   * read: a quiet stream is a lost stream.
   */
  readonly battery: { readonly facts: BatterySleepFacts } | null
  /**
   * Has a consumer been asking for this stream for longer than a wake needs
   * (`WAKE_DEMAND_BOUND_MS`)? A demand that only just arrived has not failed yet.
   */
  readonly demanded: boolean
  readonly nowMs: number
}

export type StaleStreamVerdict =
  | { readonly kind: 'outage'; readonly reason: StreamOutageReason }
  | { readonly kind: 'suppressed'; readonly presence: BatteryPresence }

export function judgeStaleStream(input: StaleStreamInput): StaleStreamVerdict {
  if (input.battery === null) return { kind: 'outage', reason: 'stale-timeout' }
  const presence = deriveBatteryPresence({
    status: input.battery.facts,
    nowMs: input.nowMs,
  })
  if (presence === 'unreachable') return { kind: 'outage', reason: 'battery-unreachable' }
  if (presence === 'awake') {
    const awakeSince = input.battery.facts.awakeSince
    if (awakeSince !== undefined && input.nowMs - awakeSince < WAKE_DEMAND_BOUND_MS) {
      return { kind: 'suppressed', presence }
    }
    return { kind: 'outage', reason: 'connection-error' }
  }
  if (input.demanded) return { kind: 'outage', reason: 'wake-timeout' }
  return { kind: 'suppressed', presence }
}
