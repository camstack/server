/**
 * D915: the device page shows ONE section per `hero` widget the device's
 * capabilities declare, directly under the hero card — driven by the aggregate (which the server
 * builds by walking the device's bindings, D12/D13), never by device type.
 * The helper knows no widget by name. Consumables is NOT one of them any more:
 * it moved into the device card (D1023), so no hero widget carries its id.
 */
import type { ConfigSectionWithValues } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { heroDrawnWidgets } from '../hero-drawn-widgets'
import { heroWidgets } from '../hero-widgets'

const EXAMPLE = 'host/example-hero'

/** A hero section carrying one widget, whatever its id: the helper names none. */
const heroSection = (order = 5, widgetId = EXAMPLE): ConfigSectionWithValues => ({
  id: `${widgetId}-section`,
  title: 'Example',
  tab: 'example',
  location: 'hero',
  order,
  fields: [{ type: 'widget', key: 'example', label: 'Example', widgetId }],
})

const zonesTopTab: ConfigSectionWithValues = {
  id: 'zones',
  title: 'Zones',
  tab: 'zones',
  location: 'top-tab',
  fields: [{ type: 'widget', key: 'z', label: 'Zones', widgetId: 'host/motion-zones' }],
}

describe('heroWidgets', () => {
  it('a device whose cap declares a hero widget gets it, for its own id', () => {
    expect(heroWidgets({ sections: [heroSection(), zonesTopTab], deviceId: 502 })).toEqual([
      { widgetId: EXAMPLE, deviceId: 502, order: 5 },
    ])
  })

  it('a device with no hero widget declaration gets nothing — no device-type fallback', () => {
    expect(heroWidgets({ sections: [zonesTopTab], deviceId: 501 })).toEqual([])
    expect(heroWidgets({ sections: [], deviceId: 501 })).toEqual([])
  })

  it('a container shows its primary child’s hero widgets, rendered against the child', () => {
    expect(
      heroWidgets({
        sections: [],
        deviceId: 3,
        child: { sections: [heroSection()], deviceId: 4 },
      }),
    ).toEqual([{ widgetId: EXAMPLE, deviceId: 4, order: 5 }])
  })

  it('the device’s own widget wins a collision with its child’s — ONE section, never two', () => {
    expect(
      heroWidgets({
        sections: [heroSection()],
        deviceId: 3,
        child: { sections: [heroSection()], deviceId: 4 },
      }),
    ).toEqual([{ widgetId: EXAMPLE, deviceId: 3, order: 5 }])
  })

  it('orders several hero widgets by their declared order', () => {
    const other: ConfigSectionWithValues = {
      ...heroSection(1),
      id: 'other-widget',
      fields: [{ type: 'widget', key: 'o', label: 'Other', widgetId: 'host/other' }],
    }
    expect(
      heroWidgets({ sections: [heroSection(5), other], deviceId: 1 }).map((w) => w.widgetId),
    ).toEqual(['host/other', EXAMPLE])
  })

  it("leaves out a widget the device's own hero card draws, keeping the rest", () => {
    const power: ConfigSectionWithValues = {
      id: 'power-meter-widget',
      title: 'Power',
      tab: 'power',
      location: 'hero',
      order: 4,
      fields: [{ type: 'widget', key: 'p', label: 'Power', widgetId: 'host/power-meter-line' }],
    }
    expect(
      heroWidgets({
        sections: [power, heroSection()],
        deviceId: 9,
        drawnByHero: ['host/power-meter-line'],
      }).map((w) => w.widgetId),
    ).toEqual([EXAMPLE])
  })

  it('a Sensor hero draws the reading itself; other types declare nothing', () => {
    expect(heroDrawnWidgets('sensor')).toEqual(['host/power-meter-line'])
    expect(heroDrawnWidgets('washer')).toEqual([])
    expect(heroDrawnWidgets(undefined)).toEqual([])
  })
})
