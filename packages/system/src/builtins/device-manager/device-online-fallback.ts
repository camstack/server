/**
 * What "online" means for a device the hub can only see on disk.
 *
 * The authority for a device's liveness is the addon that owns it (D224): it
 * publishes `device-status` through `markOnline`, the hub mirrors that slice,
 * and every persisted-row projection reads the mirror. The FALLBACK — what the
 * hub answers before any slice has arrived — used to be "a persisted row
 * implies a successful registration, so: online". That assumption is false for
 * exactly one shape of row, and it is the shape a bad removal leaves behind: a
 * top-level device with NO configuration, which its provider can never restore
 * (its config schema rejects an empty blob), so no owner will ever publish a
 * slice contradicting the guess.
 *
 * Device 105 was reported `online: true` for a full day that way, while its
 * provider logged `Failed to restore device` eight times. A device without
 * configuration cannot be online — the row is a leftover, not a camera. See
 * D376.
 *
 * Children are left on the legacy fallback deliberately: an accessory child
 * (siren, floodlight, PIR) legitimately carries an empty config blob and gets
 * its liveness from the parent's worker.
 */

export interface PersistedOnlineFallbackInput {
  /** Is a hub-side device registry present at all? `false` is the "offline view". */
  readonly registryPresent: boolean
  /** `null` for a top-level device. */
  readonly parentDeviceId: number | null
  /** The device's persisted config blob, as read from its device store. */
  readonly config: Record<string, unknown> | undefined
}

/**
 * The value to hand `resolveDeviceOnline` as its fallback. The mirrored
 * `device-status` slice, when one exists, still wins over this.
 */
export function persistedOnlineFallback(input: PersistedOnlineFallbackInput): boolean {
  if (!input.registryPresent) return false
  if (input.parentDeviceId !== null) return true
  return Object.keys(input.config ?? {}).length > 0
}
