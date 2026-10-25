/**
 * "Asleep" and "gone" are two different facts, and a battery camera reports
 * neither by itself.
 *
 * A mains camera answers "are you there?" because something may ask it. A
 * battery camera may not be asked: the question IS the damage — a Baichuan
 * login on a sleeping Argus is itself a wake event, so a reachability poll
 * that proves a camera is alive is the same poll that flattens it (D173).
 *
 * That leaves exactly one honest way to tell a healthy sleeper from a dead
 * battery: **wait, and notice**. Every signal that reaches us WITHOUT us
 * reaching for the camera — a firmware push, an inbound motion email, an
 * observed wake, a round-trip somebody else's demand already paid for — stamps
 * `BatteryStatus.lastContactAt`. Silence past a threshold is then a positive
 * observation rather than an absence of one.
 *
 * ## Why this is a function and not a stored field
 *
 * The stored fact is the CONTACT. The verdict is a reading of it against a
 * clock and a threshold, so storing the verdict would create a second
 * authority that goes stale the moment nobody rewrites it — the exact shape
 * D62 forbids for per-camera switches, for the same reason: two knobs that can
 * disagree are worse than one. Every surface (badge, camera status, snapshot
 * courtesy frame, stream error) calls this, so they cannot disagree.
 *
 * ## The failure direction
 *
 * Toward `sleeping`. `unreachable` is a FAULT — it lights a badge and it is
 * meant to be believed — so it is only ever returned when we have positively
 * seen silence for longer than the threshold. A slice we have never written
 * (`lastContactAt` absent or 0) answers `sleeping`, never `unreachable`: a
 * freshly-adopted camera, or one whose slice was lost, has told us nothing,
 * and "we know nothing" must never be painted as "it is broken". That is D62's
 * rule — disabled must never look like broken — applied to the third state.
 */

import type { BatteryStatus } from '../capabilities/battery.cap.js'

/**
 * What a battery-operated device is doing, as far as PASSIVE evidence can say.
 *
 * - `awake` — the firmware is up right now. Reads are cheap, streams dial.
 * - `sleeping` — low-power, and that is NORMAL. Not a fault, never a fault
 *   badge; a stream can still be had by asking for a wake.
 * - `unreachable` — nothing passive has arrived for longer than the
 *   threshold. Flat battery, off the LAN, unpaired. This IS a fault and the
 *   surface must say so.
 */
export type BatteryPresence = 'awake' | 'sleeping' | 'unreachable'

/**
 * Default silence budget before a sleeping battery camera is called gone.
 *
 * Sized off the mechanism that produces contact, not off taste: a battery cam
 * on this deployment surfaces a firmware push (battery level, sleep/wake, or a
 * motion email) on the order of hours even with no visitors, and the snapshot
 * wrapper's own battery window is 1 hour. Six hours is therefore several
 * missed opportunities, not one — so a single quiet night does not raise a
 * fault, and a genuinely flat camera is named well inside a day.
 */
export const BATTERY_UNREACHABLE_AFTER_MS = 6 * 60 * 60_000

export interface BatteryPresenceInput {
  /** The device's `battery` runtime-state slice, or `undefined` when it has none. */
  readonly status: Pick<BatteryStatus, 'sleeping' | 'lastContactAt'> | undefined | null
  /** Clock. Pass explicitly from callers that already hold one. */
  readonly nowMs: number
  /** Silence budget. Defaults to {@link BATTERY_UNREACHABLE_AFTER_MS}. */
  readonly unreachableAfterMs?: number
}

/**
 * THE derivation. One crop rectangle, one presence verdict — see D52 for why
 * this repo insists a derived value has exactly one implementation.
 *
 * `undefined` status ⇒ `sleeping`. A device with no slice has made no claim,
 * and the caller decides separately whether it is even battery-operated
 * (`DeviceFeature.BatteryOperated`); this function never answers that
 * question, only what a battery device is doing.
 */
export function deriveBatteryPresence(input: BatteryPresenceInput): BatteryPresence {
  const status = input.status
  if (!status) return 'sleeping'
  if (status.sleeping !== true) return 'awake'
  const lastContactAt = status.lastContactAt
  // Never contacted, or a slice that predates the field: we have seen no
  // silence, only absence of evidence. Sleeping, never a fault.
  if (typeof lastContactAt !== 'number' || lastContactAt <= 0) return 'sleeping'
  const budget = input.unreachableAfterMs ?? BATTERY_UNREACHABLE_AFTER_MS
  // A clock that ran backwards (restored slice from a node whose time was
  // corrected) yields a negative silence — which is not evidence of silence.
  const silenceMs = input.nowMs - lastContactAt
  return silenceMs > budget ? 'unreachable' : 'sleeping'
}

/**
 * Is this presence a FAULT the operator should be told about?
 *
 * Exists so no surface has to re-decide it — the whole point of the third
 * state is that `sleeping` stops being rendered as breakage, and a caller that
 * writes `presence !== 'awake'` has silently undone that.
 */
export function isBatteryPresenceFault(presence: BatteryPresence): boolean {
  return presence === 'unreachable'
}
