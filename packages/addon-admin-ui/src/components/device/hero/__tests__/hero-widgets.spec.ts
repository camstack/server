/**
 * D915: the device page shows ONE section per `hero` widget the device's
 * capabilities declare, directly under the hero card — driven by the aggregate (which the server
 * builds by walking the device's bindings, D12/D13), never by device type.
 * Today that is the Consumables panel; the helper knows no widget by name.
 */
import type { ConfigSectionWithValues } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { heroWidgets } from '../hero-widgets'

const consumables = (order = 5): ConfigSectionWithValues => ({
  id: 'consumables-widget',
  title: 'Consumables',
  tab: 'consumables',
  location: 'hero',
  order,
  fields: [
    {
      type: 'widget',
      key: 'consumablesWidget',
      label: 'Consumables',
      widgetId: 'host/consumables-panel',
    },
  ],
})

const zonesTopTab: ConfigSectionWithValues = {
  id: 'zones',
  title: 'Zones',
  tab: 'zones',
  location: 'top-tab',
  fields: [{ type: 'widget', key: 'z', label: 'Zones', widgetId: 'host/motion-zones' }],
}

describe('heroWidgets', () => {
  it('a device bound to consumables gets the Consumables widget, for its own id', () => {
    expect(heroWidgets({ sections: [consumables(), zonesTopTab], deviceId: 502 })).toEqual([
      { widgetId: 'host/consumables-panel', deviceId: 502, order: 5 },
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
        child: { sections: [consumables()], deviceId: 4 },
      }),
    ).toEqual([{ widgetId: 'host/consumables-panel', deviceId: 4, order: 5 }])
  })

  it('the device’s own widget wins a collision with its child’s — ONE section, never two', () => {
    expect(
      heroWidgets({
        sections: [consumables()],
        deviceId: 3,
        child: { sections: [consumables()], deviceId: 4 },
      }),
    ).toEqual([{ widgetId: 'host/consumables-panel', deviceId: 3, order: 5 }])
  })

  it('orders several hero widgets by their declared order', () => {
    const other: ConfigSectionWithValues = {
      ...consumables(1),
      id: 'other-widget',
      fields: [{ type: 'widget', key: 'o', label: 'Other', widgetId: 'host/other' }],
    }
    expect(
      heroWidgets({ sections: [consumables(5), other], deviceId: 1 }).map((w) => w.widgetId),
    ).toEqual(['host/other', 'host/consumables-panel'])
  })
})
