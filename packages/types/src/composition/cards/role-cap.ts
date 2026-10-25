/**
 * Map a device role to the primary composition cap (D939).
 */
import { CAP_NAMES } from '../../generated/addon-cap-facts.js'
import { DeviceRole } from '../../device/device-type.js'

const ROLE_CAP_ALIASES: Readonly<Record<string, string>> = {
  [DeviceRole.BinarySensor]: 'binary',
  [DeviceRole.MotionSensor]: 'motion',
}

// Names only: the full definitions would inline the whole schema graph into every addon (D28).
const KNOWN_CAPS: ReadonlySet<string> = new Set(CAP_NAMES)

export function primaryCapForRole(role: string | null): string | null {
  if (role === null || role === '') return null
  const aliased = ROLE_CAP_ALIASES[role]
  if (aliased !== undefined) return KNOWN_CAPS.has(aliased) ? aliased : null
  return KNOWN_CAPS.has(role) ? role : null
}
