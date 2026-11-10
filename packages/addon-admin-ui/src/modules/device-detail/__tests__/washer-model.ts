import { buildHeroModel, type HeroModel } from '@camstack/types'

const NOW = 1_700_000_000_000

/** The hero model of a running washer, built with the shared pure builder. */
export const WASHER_MODEL: HeroModel = buildHeroModel({
  device: { id: 7, type: 'washer', role: null, name: 'Device', online: true },
  caps: ['running-state', 'power-meter'],
  features: [],
  slices: {
    'running-state': {
      running: true,
      since: NOW - 60_000,
      source: 'native',
      phase: 'Rinse',
      lastFetchedAt: NOW,
    },
    'power-meter': { power: 412, energy: 18.4, lastFetchedAt: NOW },
  },
  now: NOW,
  remoteCommands: null,
  access: { canActuate: true },
})
