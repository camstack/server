/**
 * A battery reading reduced to the only thing worth storing: its BAND.
 *
 * ## Why a band and not the percentage
 *
 * The `battery` runtime-state slice is written far more often than it changes.
 * The runtime-state census quoted in `battery.cap.ts` measured **526 writes in
 * 25 minutes with 0 value changes** — `lastUpdated` alone moving. A ledger keyed
 * on the reading would treat each of those as a fact worth comparing; keyed on
 * the band it discards every one of them before any notification logic runs.
 *
 * It is also what makes a RECOVERY notification safe to offer at all. The
 * recovery fires on a band TRANSITION recorded in the ledger, never on a value
 * re-crossing the threshold, so a reading that oscillates around the edge
 * cannot produce alternating low/normal pairs.
 *
 * ## The three answers, and why one of them is `null`
 *
 * `null` means **this device has not told us anything**, and it is not the same
 * as `normal`. Measured on the live hub 2026-09-01, three devices carry
 * `{percentage: 0, lastUpdated: 0}` — 3255, 3279, 3609 — which was, at that
 * time, the cap's cold seed (a legacy value now replaced by `{percentage:
 * null, ...}`, D663). A gate written as `percentage <= threshold` announces a
 * flat battery for three devices that have never reported one. The D62
 * direction applies to the third state as it does everywhere else in this
 * repo: unknown must never be painted as broken.
 *
 * ## Binary indicators are not measurements
 *
 * `BatteryStatus.binary` marks a source that only ever says LOW or NORMAL (an
 * HA `binary_sensor` with `device_class=battery`, the `LOW_BAT` shape). The HA
 * container writes 15 % for low and 100 % for normal
 * (`ha-container-device.ts`), and the 15 was chosen to sit under the
 * conventional 20 % warning band so that consumers' alerting fires by
 * coincidence. Nine devices on this fleet are binary and two of them read LOW
 * right now.
 *
 * That coincidence is not something to build on. An operator who sets the
 * threshold to 10 would silence both, and nothing would say why. So the
 * operator's threshold is applied to MEASUREMENTS only; a binary source is read
 * for what it is — the provider already decided, and it is the authority.
 *
 * Pure. No clock, no I/O.
 */

/** The band a device's battery is in. `null` is the third answer — see above. */
export type NcBatteryBand = 'low' | 'normal'

/**
 * The stand-in a provider writes for a binary NORMAL. Anything below it, on a
 * binary source, is the provider saying LOW. Kept as a comparison against the
 * top of the range rather than against the low stand-in (15) so a provider that
 * picks a different low value still reads correctly.
 */
const BINARY_NORMAL_PCT = 100

/**
 * How far above the threshold a reading must climb before the band leaves
 * `low`.
 *
 * A CONSTANT and not a setting, deliberately: the operator's decision (D-2) was
 * three cluster settings and no more, and a fourth knob whose only job is to
 * stop the third one misbehaving is a knob nobody can size. Five points is one
 * discharge-curve step on every source on this fleet.
 */
export const BATTERY_LOW_HYSTERESIS_PCT = 5

/** The fields of `BatteryStatus` this derivation reads, and nothing else. */
export interface NcBatteryReading {
  readonly percentage: number
  /** Ms epoch of the last observation. **0 means never** — see the docblock. */
  readonly lastUpdated: number
  /** True when the source is a binary LOW_BAT indicator with no real level. */
  readonly binary?: boolean
}

export interface NcBatteryBandInput {
  readonly reading: NcBatteryReading
  /** The operator's cluster threshold, in percent. Measurements only. */
  readonly thresholdPercent: number
  /** The band the ledger holds. Absent = no episode, so no hysteresis to hold. */
  readonly previous?: NcBatteryBand
}

/**
 * THE derivation. One band verdict, one implementation — D52's discipline
 * applied to the third derived value in this repo.
 *
 * `null` ⇒ say nothing at all. Not low, not recovered, not a state change: the
 * caller must leave the ledger exactly as it found it, because a device that
 * has not spoken is not evidence in either direction.
 */
export function deriveBatteryBand(input: NcBatteryBandInput): NcBatteryBand | null {
  const reading = input.reading
  if (!Number.isFinite(reading.lastUpdated) || reading.lastUpdated <= 0) return null
  if (!Number.isFinite(reading.percentage)) return null
  if (reading.binary === true) {
    // The provider already decided. No threshold, and no hysteresis — a source
    // with two states cannot oscillate within a band it does not have.
    return reading.percentage < BINARY_NORMAL_PCT ? 'low' : 'normal'
  }
  // Hysteresis is one-directional on purpose: a fault is believed the moment it
  // is measured, and only the RECOVERY has to clear the edge. The mirror of
  // `isBatteryPresenceFault`'s rule — the failure direction is toward not
  // claiming things are fine.
  if (input.previous === 'low') {
    return reading.percentage >= input.thresholdPercent + BATTERY_LOW_HYSTERESIS_PCT
      ? 'normal'
      : 'low'
  }
  return reading.percentage <= input.thresholdPercent ? 'low' : 'normal'
}
