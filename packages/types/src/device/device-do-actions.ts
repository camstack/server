/**
 * Which devices a command picker offers as targets. What a device can be told
 * to do is the cap vocabulary's (`cap-vocabulary/`, D920); a step names the
 * vocabulary action by id (D983).
 */
import { DeviceType } from './device-type.js'

/**
 * Whether a device type belongs in a command / automation action device picker.
 * A container is a parent grouping node, never an actuation target: its
 * children are.
 */
export function isDoPickerDeviceType(type: string): boolean {
  return type !== DeviceType.Container
}
