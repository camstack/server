/**
 * What the Build-your-self device pickers ask the device search for. A target
 * is any device but a container (`isDoPickerDeviceType`); a scene row picks
 * cameras only. The search applies them, so no surface keeps its own list.
 */
import { DeviceType } from '@camstack/types'

/** Never offered as a trigger source or a command target. */
export const BUILD_EXCLUDED_TYPES: readonly string[] = [DeviceType.Container]

/** A scene row's camera. */
export const CAMERA_TYPES: readonly string[] = [DeviceType.Camera]
