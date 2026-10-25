/**
 * The device-native provider is the one a contribution call REACHES.
 *
 * `child-cap-dispatch` resolves `(cap, deviceId)` to the device-scoped provider
 * whenever the call carries a `deviceId`, and never falls back to the singleton
 * when the method is missing — it throws. `getDeviceSettingsContribution`
 * always carries one, so for a cap registered through `registerNativeCap` the
 * contribution has to be ON that provider. Carrying it on an addon-level
 * wrapper compiles, registers, and answers
 *   "method 'getDeviceSettingsContribution' not found on provider
 *    'camera-grid-layout'"
 * on the live hub — which is exactly what it did (HTTP 500, 2026-09-17).
 */
import { describe, expect, it } from 'vitest'
import type { GridLayoutPatch, GridLayoutView } from '@camstack/types'
import { buildGridLayoutNativeProvider } from '../grid-layout-native-provider.js'
import { GRID_LAYOUT_WIDGET_ID } from '../grid-device-settings.js'

const VIEW: GridLayoutView = {
  deviceId: 4581,
  instanceId: '6a2f1b3c-0000-4000-8000-000000000001',
  name: 'Front yard 2x2',
  fps: 10,
  cells: [],
  profiles: [],
}

function providerFor(layout: GridLayoutView | null) {
  return buildGridLayoutNativeProvider({
    getLayout: () => layout,
    saveLayout: async (_patch: GridLayoutPatch) => VIEW,
  })
}

describe('buildGridLayoutNativeProvider', () => {
  it('carries the contribution methods on the NATIVE provider', () => {
    const provider = providerFor(VIEW)
    expect(typeof provider.getDeviceSettingsContribution).toBe('function')
    expect(typeof provider.getDeviceLiveContribution).toBe('function')
    expect(typeof provider.applyDeviceSettingsPatch).toBe('function')
  })

  it('returns the layout section for a grid, carrying the widget', async () => {
    const contribution = await providerFor(VIEW).getDeviceSettingsContribution({ deviceId: 4581 })
    expect(contribution).not.toBeNull()
    const section = contribution?.sections?.[0]
    expect(section?.id).toBe('camera-grid-layout')
    // Inside the main Config tab: no `location` (a `top-tab` would be lifted
    // out of Config by `DeviceAggregateSection`), grouped under `general`.
    expect(section?.location).toBeUndefined()
    expect(section?.tab).toBe('general')
    const field = section?.fields?.[0]
    expect(field?.type).toBe('widget')
    expect(field !== undefined && field.type === 'widget' ? field.widgetId : null).toBe(
      GRID_LAYOUT_WIDGET_ID,
    )
  })

  it('DECLINES for a device the addon does not know as a grid', async () => {
    const contribution = await providerFor(null).getDeviceSettingsContribution({ deviceId: 99 })
    expect(contribution).toBeNull()
  })

  it('still answers the data methods the cap was registered for', async () => {
    const provider = providerFor(VIEW)
    expect(await provider.getLayout({ deviceId: 4581 })).toEqual(VIEW)
  })
})
