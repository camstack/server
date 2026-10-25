/**
 * The grid builds its own device-page section, including where it lands.
 *
 * The point of this shape over a `deviceConfig.ui` block is the refusal: a
 * camera that is not a grid must get NO section, rather than a widget that
 * renders its own "this is not a grid" state.
 */
import { describe, expect, it } from 'vitest'
import { buildGridDeviceSchema, GRID_LAYOUT_WIDGET_ID } from '../grid-device-settings.js'

describe('buildGridDeviceSchema', () => {
  it('declines for a camera that is not a grid', () => {
    expect(buildGridDeviceSchema(false)).toBeNull()
  })

  it('carries the widget and its placement together', () => {
    const schema = buildGridDeviceSchema(true)
    const section = schema?.sections[0]
    expect(section?.id).toBe('camera-grid-layout')
    // The main Config tab: no `location` (a `top-tab` section is lifted OUT of
    // Config by `DeviceAggregateSection`), grouped under `general`.
    expect(section?.tab).toBe('general')
    expect(section?.location).toBeUndefined()
    expect(section?.order).toBe(20)
    const field = section?.fields[0]
    expect(field?.type).toBe('widget')
    expect(field && 'widgetId' in field ? field.widgetId : null).toBe(GRID_LAYOUT_WIDGET_ID)
  })

  /**
   * The id must match the `HOST_WIDGETS` key in ui-library. A drift here is
   * silent: the section renders and the slot resolves to nothing.
   */
  it('names the registered widget id', () => {
    expect(GRID_LAYOUT_WIDGET_ID).toBe('host/camera-grid-layout')
  })
})
