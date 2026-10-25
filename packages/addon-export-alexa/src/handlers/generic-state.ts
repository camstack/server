/**
 * A generic device's Alexa properties from its cap slices (R5, D775; adapter
 * registry D869) — ONE mapping shared by `Alexa/ReportState` (reading each
 * cap's status), the proactive reports (`DeviceStateChanged` slices) and the
 * reconcile, so they can never answer differently for the same state. The
 * mapping itself lives in the per-cap adapters (`endpoints/adapters/`).
 */
import {
  GENERIC_STATE_CAPS,
  type GenericProperty,
  genericPropertiesFor,
} from '../endpoints/adapters/index.js'

export { GENERIC_STATE_CAPS, genericPropertiesFor }
export type { GenericProperty }

/** The first Alexa property one cap slice sets, or null (unknown cap, bad slice). */
export function genericPropertyFor(capName: string, slice: unknown): GenericProperty | null {
  return genericPropertiesFor(capName, slice)[0] ?? null
}
