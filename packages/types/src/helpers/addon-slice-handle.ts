import type { SliceHandleApi } from '../device/device-state-handle.js'
import type { AddonApi } from '../generated/addon-api.js'

/** Structural bridge: every `AddonApi` client carries `deviceState` (+ optional `live`). */
export function addonSliceHandleApi(api: AddonApi): SliceHandleApi {
  return api
}
