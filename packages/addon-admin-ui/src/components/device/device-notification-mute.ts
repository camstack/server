/**
 * The per-device NOTIFICATION mute, derived from the authority that already
 * owns it ([D113](../../../../docs/decisions/adr-0113.md) phase 3).
 *
 * | Function | Authority read | Authority written |
 * | --- | --- | --- |
 * | `notifications` | `notificationRules.listDeviceMutes().mutedDeviceIds` | `notificationRules.setDeviceMuted` |
 *
 * This is the row D113's table marked **not built yet — phase 3**: the mute had
 * exactly ONE surface, the aggregate switch group, and that group is being
 * deleted. Until this existed, deleting it would have left a durable,
 * indefinite silence (`notification-center:device-mutes`) that the notification
 * centre still reads on every event and no operator could see or lift.
 *
 * It stores NOTHING. `mutedDeviceIds` is the notification centre's own row set
 * and the toggle writes straight back to it, so this surface and the alarm's
 * `skippedDevices: 'muted'` accounting can never disagree — they are reading
 * the same store one call apart.
 *
 * **Polarity is deliberate.** The authority's fact is `muted`; the control is
 * "Notifications", which is ON when the device is NOT muted. Every conversion
 * happens here, once, so no component has to remember which way round it goes —
 * a switch that writes the inverse of what it shows is the exact failure mode
 * the broker-audio row carries too.
 *
 * The rule the `null` exists for: **a read that did not answer is unknown,
 * never "not muted"**. Drawing a silent device as notifying is how an operator
 * spends an evening asking why an alarm never fired.
 */

/** One rendered mute control. */
export interface NotificationMuteState {
  /** Operator-facing name of the FUNCTION, not of the fact. */
  readonly label: string
  /**
   * Is this device allowed to notify? `null` = `listDeviceMutes` did not
   * answer, and is never coerced to `true`.
   */
  readonly on: boolean | null
  /** A control is only offered when the state is known. */
  readonly available: boolean
  /** What the operator loses while it is off, worded for this device. */
  readonly costWhenOff: NotificationMuteCost
}

/** One translatable sentence: its catalogue key and its English text. */
export interface NotificationMuteCost {
  readonly i18nKey: string
  readonly text: string
}

export const NOTIFICATION_MUTE_LABEL = 'Notifications'

/**
 * A camera keeps recording and tracking while muted, so its sentence says so.
 * Any other device (a dishwasher, a sensor) has no tracks or recordings, so
 * its sentence names neither — and calls it a device, not a camera.
 */
const CAMERA_COST_WHEN_OFF: NotificationMuteCost = {
  i18nKey: 'device.deviceNotificationMute.cameraCostWhenOff',
  // i18n-ignore: the English fallback of i18nKey, rendered through t()
  text: 'This camera never notifies — no rule, no target, no alarm. Existing events, tracks and recordings are unaffected.',
}

const DEVICE_COST_WHEN_OFF: NotificationMuteCost = {
  i18nKey: 'device.deviceNotificationMute.deviceCostWhenOff',
  // i18n-ignore: the English fallback of i18nKey, rendered through t()
  text: 'This device never notifies — no rule, no target, no alarm.',
}

/** What one `notificationRules.listDeviceMutes` answer contributes. */
export interface NotificationMuteInput {
  /** `listDeviceMutes().mutedDeviceIds`; `null` when the read failed. */
  readonly mutedDeviceIds: readonly number[] | null
  readonly deviceId: number
  /** The device is a camera (its type) — decides how the cost is worded. */
  readonly isCamera: boolean
  /**
   * A write this surface issued that has not settled yet — the value it asked
   * for. `null` when nothing is in flight. Kept OUT of the query cache on
   * purpose: an optimistic patch written under a guessed react-query key
   * silently does nothing, and a mute that reads back wrong is worse than one
   * that takes a beat to appear.
   */
  readonly pendingOn?: boolean | null
}

/**
 * Derive the control from one authority read.
 *
 * An in-flight write wins over the last server answer — and ONLY over a known
 * one. A pending flip on top of an unknown read would draw a state nothing has
 * confirmed, which is the same claim as defaulting the read to "on".
 */
export function resolveNotificationMute(input: NotificationMuteInput): NotificationMuteState {
  const { mutedDeviceIds, deviceId } = input
  const read = mutedDeviceIds === null ? null : !mutedDeviceIds.includes(deviceId)
  const pending = input.pendingOn ?? null
  const on = read === null ? null : (pending ?? read)
  return {
    label: NOTIFICATION_MUTE_LABEL,
    on,
    available: read !== null,
    costWhenOff: input.isCamera ? CAMERA_COST_WHEN_OFF : DEVICE_COST_WHEN_OFF,
  }
}

/**
 * The authority write ONE toggle implies, in the authority's own vocabulary.
 *
 * Exported so the polarity flip is pinned by a test rather than living inline
 * in a click handler: `setDeviceMuted({ muted })` is the inverse of the control,
 * and the group this replaces shipped an inverted-polarity carve-out (D74/D83)
 * for getting one of these backwards.
 *
 * A type alias rather than an interface deliberately: the generated cap
 * mutation takes the router's LOOSE input (`{ [x: string]: unknown } & …`) and
 * an interface has no implicit index signature, so declaring this as one would
 * force a cast at the one call site that matters.
 */
export type NotificationMuteWrite = {
  readonly deviceId: number
  readonly muted: boolean
}

export function notificationMuteWrite(
  state: NotificationMuteState,
  deviceId: number,
): NotificationMuteWrite | null {
  // Unknown is not a control, so it cannot produce a write either. A toggle
  // over a state nothing confirmed writes the opposite of what the operator
  // sees half the time.
  if (!state.available || state.on === null) return null
  return { deviceId, muted: state.on }
}
