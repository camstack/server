/** Tutti1 devices: climate, appliances, pets (see `hero-mockups.ts`). */
import { NOW } from './_time'
import type { MockupSpec } from './hero-mockups'

const CLIMATE = {
  mode: 'cool',
  availableModes: ['off', 'auto', 'cool', 'heat', 'dry', 'fan_only'],
  fanMode: 'auto',
  availableFanModes: ['auto', 'low', 'medium', 'high'],
  preset: '',
  availablePresets: [],
  target: 24,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: 26.1,
  currentHumidity: 58,
  swingVertical: null,
  swingHorizontal: null,
  minTemp: 16,
  maxTemp: 30,
  tempStep: 1,
  lastFetchedAt: NOW,
}

export const SPECS_TUTTI1: Readonly<Record<number, MockupSpec>> = {
  1101: {
    name: 'Climatizzatore salone',
    type: 'climate',
    provider: 'Midea',
    caps: ['device-status', 'climate-control', 'power-meter', 'consumables'],
    slices: {
      'climate-control': CLIMATE,
      'power-meter': { power: 820, energy: 3.4, lastFetchedAt: NOW },
      consumables: {
        items: [
          {
            key: 'filter',
            label: 'Filtro',
            level: 40,
            status: 'ok',
            lastResetAt: null,
            resettable: true,
          },
        ],
        lastChangedAt: NOW,
      },
    },
  },
}
