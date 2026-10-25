/**
 * The device-manager's persisted-icon decoders accept every value that could
 * be stored before the icon catalog replaced the two vocabularies (D854).
 *
 * There is no migration: rows written under the closed 20-icon location subset
 * must keep decoding, and a spelling the catalog only ALIASES must resolve to
 * its canonical key rather than being dropped.
 */
import { describe, expect, it } from 'vitest'
import { decodeAddonStore } from '../device-meta-types.js'

/** The 20 ids of the retired `LOCATION_ICON_IDS`, frozen. */
const RETIRED_LOCATION_VALUES = [
  'map-pin',
  'house',
  'door-open',
  'sofa',
  'utensils',
  'bed-double',
  'bath',
  'briefcase',
  'car',
  'circle-parking',
  'route',
  'trees',
  'umbrella',
  'waves-ladder',
  'fence',
  'package',
  'warehouse',
  'store',
  'sun',
  'radar',
] as const

describe('decodeAddonStore — icons', () => {
  it('keeps every retired location id, on a location and on a zone', () => {
    expect(RETIRED_LOCATION_VALUES.length).toBe(20)
    const locationIcons = Object.fromEntries(RETIRED_LOCATION_VALUES.map((id) => [id, id]))
    const siteZones = Object.fromEntries(
      RETIRED_LOCATION_VALUES.map((id) => [id, { label: id, icon: id }]),
    )
    const decoded = decodeAddonStore({ locationIcons, siteZones })
    expect(decoded.locationIcons).toEqual(locationIcons)
    for (const id of RETIRED_LOCATION_VALUES) {
      expect(decoded.siteZones?.[id]?.icon, id).toBe(id)
    }
  })

  it('accepts ANY catalog icon now, not only the retired subset', () => {
    const decoded = decodeAddonStore({
      locationIcons: { sala: 'telescope' },
      siteZones: { z: { label: 'Z', icon: 'telescope' } },
    })
    expect(decoded.locationIcons).toEqual({ sala: 'telescope' })
    expect(decoded.siteZones?.['z']?.icon).toBe('telescope')
  })

  it('stores a still-accepted spelling under its canonical key', () => {
    const decoded = decodeAddonStore({
      locationIcons: { casa: 'home' },
      siteZones: { z: { label: 'Z', icon: 'home' } },
    })
    expect(decoded.locationIcons).toEqual({ casa: 'house' })
    expect(decoded.siteZones?.['z']?.icon).toBe('house')
  })

  it('still drops a value that is not an icon at all, and keeps the zone', () => {
    const decoded = decodeAddonStore({
      locationIcons: { kitchen: 'teapot-not-an-icon', garage: 'car' },
      siteZones: { z: { label: 'Z', icon: 'nope' } },
    })
    expect(decoded.locationIcons).toEqual({ garage: 'car' })
    expect(decoded.siteZones?.['z']).toEqual({ label: 'Z' })
  })
})
