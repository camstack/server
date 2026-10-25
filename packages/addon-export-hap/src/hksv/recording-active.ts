/**
 * Whether HomeKit is recording this camera — read from HomeKit, at call time.
 *
 * ## Why there is no stored value here
 *
 * "Record this camera" is HomeKit's decision. iOS asks it during setup
 * ("Stream" or "Stream and Allow Recording"), writes it to the
 * `CameraRecordingManagement.Active` characteristic, and hap-nodejs persists
 * that across reboots. The prebuffer runs only while it is on.
 *
 * This addon used to keep its own switch beside it. Two authorities over one
 * function is D62's defect, and it cost exactly what D62 says it costs: the day
 * the switch's default was flipped, 101 kept teeing HomeKit clips from an
 * accessory built under the old default while every surface reported that the
 * camera had no HomeKit source at all. Nobody had touched anything.
 *
 * So the answer is read from the accessory each time it is asked. No mirror, no
 * cache, no callback that can be missed — the characteristic IS the state, and
 * an accessory is in this process.
 *
 * ## `null` is not `false`
 *
 * A camera whose accessory carries no recording service was never OFFERED
 * recording (no copyable slot, an unreadable profile list). That is a different
 * thing from an operator who declined it in Home, and folding the two together
 * would make a camera we refused look like a camera they refused (D315, D393).
 */
import type { Accessory } from '@homebridge/hap-nodejs'
import { Characteristic, Service } from '@homebridge/hap-nodejs'

/**
 * `true`/`false` as HomeKit holds it, or `null` when this accessory does not
 * offer recording at all.
 */
export function readHomekitRecordingActive(accessories: readonly Accessory[]): boolean | null {
  for (const accessory of accessories) {
    const service = accessory.getService(Service.CameraRecordingManagement)
    if (service === undefined) continue
    const value = service.getCharacteristic(Characteristic.Active).value
    // The characteristic is an Active enum (0/1) on the wire. Anything else is
    // a value we did not write and will not interpret.
    if (typeof value === 'number') return value === 1
    if (typeof value === 'boolean') return value
    return null
  }
  return null
}

/**
 * One sentence for the settings page: what HomeKit says, or why it was never
 * asked.
 *
 * The cost stays in the text even though the switch is gone. It is still the
 * operator's to understand — a camera recording here runs a permanent ffmpeg —
 * and a status line that reported only the state would have quietly dropped
 * the one number that decides whether to turn it on.
 */
export function describeHomekitRecording(
  active: boolean | null,
  lastBuild: { readonly advertised: boolean; readonly detail: string | null } | null,
): string {
  if (active === true) {
    return 'HomeKit is recording this camera. Turn it off in the Home app (Camera settings → “Stream”), not here — iOS owns this switch and keeps it across reboots. While it is on, this camera runs a permanent prebuffer (~0.7% of one CPU core on the copy branch).'
  }
  if (active === false) {
    return 'This camera offers recording and HomeKit has it off. Turn it on in the Home app (Camera settings → “Stream and Allow Recording”); it needs iCloud+ and a home hub. Nothing runs here until you do.'
  }
  if (lastBuild !== null && !lastBuild.advertised) {
    return `Recording is not offered for this camera: ${lastBuild.detail ?? 'the accessory could not advertise it'}.`
  }
  return 'Not known yet — this camera’s accessory has not published its recording service in this process. It appears once the accessory is built.'
}
