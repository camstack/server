/**
 * The slice a camera sensor REPORTED, out of a `DeviceStateChanged` event
 * (D672, D1061). While the hub holds a command for the sensor the event's
 * `slice` is the effective view and `confirmed` is what the device said; a
 * camera's onboard motion follows the device, never a held command.
 */

/** A `DeviceStateChanged` slice is an object; anything else carries no state. */
function isSlice(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The reported slice of the event, or `null` when it carries none. */
export function reportedSensorSlice(
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  const confirmed = data['confirmed']
  if (isSlice(confirmed)) return confirmed
  const slice = data['slice']
  return isSlice(slice) ? slice : null
}
