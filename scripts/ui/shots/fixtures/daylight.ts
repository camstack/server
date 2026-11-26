/**
 * System -> Settings, the "Day and night" card (planning#736/#737): a light
 * sensor is the configured source and the hub-wide authority has fallen back
 * to the sun because the sensor could not be read. Invented data.
 */
import { defineFixtures } from './_define'

const SENSOR = {
  source: 'sensor',
  deviceId: 11,
  cap: 'ambient-light-sensor',
  fieldPath: 'illuminance',
  darkBelow: 20,
  hysteresis: 10,
  minDwellMin: 15,
} as const

const DEVICE = {
  id: 11,
  name: 'Porch light sensor',
  type: 'sensor',
  location: 'Garden',
  integrationId: 'mqtt',
  integrationLabel: 'MQTT',
  online: true,
  disabled: false,
  compatible: true,
  values: [
    { cap: 'ambient-light-sensor', path: 'illuminance', label: 'Illuminance', reading: '42 lx' },
  ],
}

export default defineFixtures({
  area: 'daylight',
  description: 'daylight-phase: sensor configured, the sun answering because the read failed',
  handlers: {
    'daylightPhase.getPhase': {
      phase: { phase: 'night', since: 1_700_000_000_000, source: 'sun' },
      configured: SENSOR,
      fallbackReason: 'Porch light sensor did not answer.',
      checkedAt: 1_700_000_600_000,
    },
    'daylightPhase.getSettings': SENSOR,
    'mut:daylightPhase.setSettings': null,
    'deviceManager.search': (input: { ids?: number[] }) => ({
      items: [DEVICE],
      nextCursor: null,
      total: 1,
      compatibleTotal: 1,
      fleetTotal: 12,
      hiddenIncompatible: 0,
      facets: { locations: [], integrations: [], types: [] },
      suggested: [],
      missingIds: (input.ids ?? []).filter((id) => id !== 11),
    }),
  },
})
