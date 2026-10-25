/**
 * The `camera-grid-layout` provider, contribution included.
 *
 * ## Why the section lives on the DEVICE provider and not on the addon
 *
 * `camera-grid-layout` is registered per device, through
 * `DeviceContext.registerNativeCap`. `child-cap-dispatch` resolves a call that
 * carries a `deviceId` to the device-scoped provider FIRST, and when the method
 * is absent there it throws rather than falling back to the singleton — the
 * fallback exists only for a collection cap's list method. Every contribution
 * method carries a `deviceId` by definition, so an addon-level wrapper is
 * simply never reached: it registered, it type-checked, and the live hub
 * answered HTTP 500 with
 *   `method 'getDeviceSettingsContribution' not found on provider
 *    'camera-grid-layout'`.
 *
 * That is why the whole provider is built here, in one place, and handed to
 * `registerNativeCap` as a single object. `exposesDeviceSettings` widens
 * `InferProvider` and not `InferNativeProvider`, so the type below is the wider
 * one; registering it is safe because a native registration only ever needs a
 * SUBSET of what this carries.
 *
 * The refusal (D526) rides along: a device the addon cannot name as a grid gets
 * `null`, so a camera that is not a grid gets no section at all rather than a
 * panel that renders its own emptiness.
 */
import {
  hydrateSchema,
  type GridLayoutPatch,
  type GridLayoutView,
  type ICameraGridLayoutSettingsProvider,
} from '@camstack/types'
import { buildGridDeviceSchema } from './grid-device-settings.js'

/** What the provider needs from the running addon — nothing more. */
export interface GridLayoutSource {
  /** The grid behind a device, or `null` — "answered: not a grid". */
  getLayout(deviceId: number): GridLayoutView | null
  saveLayout(patch: GridLayoutPatch): Promise<GridLayoutView>
}

export function buildGridLayoutNativeProvider(
  source: GridLayoutSource,
): ICameraGridLayoutSettingsProvider {
  return {
    getLayout: async ({ deviceId }) => source.getLayout(deviceId),
    saveLayout: async (patch) => source.saveLayout(patch),
    getDeviceSettingsContribution: async ({ deviceId }) => {
      const schema = buildGridDeviceSchema(source.getLayout(deviceId) !== null)
      // `hydrateSchema` carries no values here — a widget stores none, it reads
      // and writes through the cap's own methods. It is what turns a plain
      // schema into the wire shape the aggregation expects.
      return schema === null ? null : hydrateSchema(schema, {})
    },
    getDeviceLiveContribution: async () => null,
    applyDeviceSettingsPatch: async () => ({ success: true as const }),
  }
}
