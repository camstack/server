/**
 * The THREE cluster settings behind the sustained-state alerts (battery band,
 * device offline).
 *
 * ## Why three, and why here
 *
 * The operator's decision (D-2/D-4 of the battery-and-offline design): one
 * threshold, one reminder interval and one recovery switch, valid for the whole
 * installation — **not** fields of a notification rule. A rule already carries
 * a cooldown, a schedule and a media policy; a threshold on it would be a
 * fourth per-rule number governing a fact that is not per-rule, and two rules
 * disagreeing about when a battery is low is the D62 shape (two knobs that can
 * contradict each other are worse than one).
 *
 * They live beside this addon's other cluster-wide behavioural knobs rather
 * than in a home of their own. The Notification Center has no general settings
 * collection — `NcAlarmSettings` is stored on the panel DEVICE, and inventing a
 * second store to hold three numbers is the "second place" this file exists not
 * to be.
 *
 * ## What is deliberately NOT a setting
 *
 * - **The hysteresis.** A constant in `alerts/battery-band.ts`. Its only job is
 *   to stop the threshold misbehaving, and a knob nobody can size is a knob
 *   that gets set wrong once and is never looked at again.
 * - **The accessory rule.** `parentDeviceId !== null` produces no liveness
 *   event, full stop. It is a property of what a device IS, not a preference.
 * - **The 5-minute liveness hold-off.** It predates this and belongs to the
 *   liveness path (`liveness-holdoff.ts`).
 */

import { z } from 'zod'

/**
 * Under this interval a "reminder" is a flood, and the operator would turn the
 * whole feature off rather than tune it. Sized against the two states it
 * covers: a battery that moves percent-per-day, and an outage that already
 * costs one notification after a 5-minute hold-off.
 */
const MIN_RENOTIFY_MINUTES = 15
/** Past a week, "remind me" is indistinguishable from off — and 0 says off. */
const MAX_RENOTIFY_MINUTES = 7 * 24 * 60

export const DeviceAlertSettingsSchema = z.object({
  /**
   * At or below this percentage a MEASURED battery is low.
   *
   * Bounded away from both ends because neither end can fire: nothing measures
   * below 0, and 100 would put every healthy device permanently in the low
   * band. Integer, because a band is not a measurement — and because a
   * fractional threshold against a firmware-reported integer is a false
   * precision that only ever surprises.
   *
   * A device whose battery is a BINARY indicator ignores this entirely: the
   * provider already decided, and its 15 %/100 % stand-ins are not readings to
   * compare (see `alerts/battery-band.ts`).
   *
   * The default agrees with the HomeKit characteristic
   * (`addon-export-hap/.../battery.ts`, `LOW_BATTERY_THRESHOLD_PCT = 20`) so
   * the phone and the hub do not contradict each other out of the box.
   */
  batteryLowPercent: z.number().int().min(1).max(99).default(20),
  // The consumable threshold USED to be the fourth number here. Since D642 it
  // is each RULE's `systemEvent.consumableLowPercent` (default 15): the
  // operator decided a rule at 25 must hear about a filter at 20 % and a rule
  // at 10 must not, which one cluster value cannot say. A stored value is
  // stripped on read (z.object drops unknown keys) and read by nothing.
  /**
   * How long a still-true alert waits before it says itself again.
   *
   * **0 = say it once.** That is the behaviour of every other notification this
   * hub sends, so it is the honest way to express "off" — a separate boolean
   * would be a second knob that can disagree with this one.
   *
   * 12 hours by default: a flat battery is a chore, not an emergency, and twice
   * a day is the cadence at which an operator actually replaces one.
   */
  alertRenotifyMinutes: z
    .number()
    .int()
    .min(0)
    .refine(
      (v) => v === 0 || (v >= MIN_RENOTIFY_MINUTES && v <= MAX_RENOTIFY_MINUTES),
      `must be 0 (say it once) or between ${MIN_RENOTIFY_MINUTES} and ${MAX_RENOTIFY_MINUTES} minutes`,
    )
    .default(720),
  /**
   * Announce the return to normal — a battery back above the threshold, a
   * device back online. Defaults ON.
   *
   * It fires on the band/state transition recorded in the LEDGER, never on a
   * raw value crossing, which is what stops a reading oscillating around the
   * threshold from producing pairs of notifications. Switching it off
   * suppresses the notification only — the ledger still moves, or the next
   * fall below the threshold could never be announced.
   */
  alertNotifyRecovery: z.boolean().default(true),
})

export type DeviceAlertSettings = z.infer<typeof DeviceAlertSettingsSchema>

/** The shipped defaults, for the settings-schema form and for tests. */
export const DEVICE_ALERT_DEFAULTS: DeviceAlertSettings = DeviceAlertSettingsSchema.parse({})
