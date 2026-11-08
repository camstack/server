/**
 * The hero model the hub would serve (`heroLayout.getHeroModel`), built here
 * with the shared pure builder from the slices of four devices the other areas
 * borrow: 505 washing machine and 521 living-room AC (`appliances`), 961 kitchen
 * Echo (`media-player`) and 971 washer plug (`hero-plug`). Load it FIRST; it
 * answers only `heroLayout.*`, so the device areas keep answering the rest.
 * 521 has only `climate-control`, which contributes nothing yet: its model has
 * no state, so the page keeps the legacy hero.
 */
import { buildHeroModel } from '../../../../packages/types/src/device/hero/build-hero-model.ts'
import { DeviceFeature } from '../../../../packages/types/src/device/device-type.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'

interface Spec {
  readonly name: string
  readonly type: string
  readonly caps: readonly string[]
  readonly features: readonly string[]
  readonly slices: Record<string, unknown>
}

const MEDIA = {
  state: 'playing',
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: 35,
  isMuted: false,
  source: 'Spotify',
  availableSources: ['Spotify', 'Line in'],
  currentMedia: {
    type: 'music',
    title: 'Blue in Green',
    artist: 'Miles Davis',
  },
  position: 98_000,
  duration: 337_000,
  shuffle: true,
  repeat: 'all',
  positionUpdatedAt: NOW,
  lastChangedAt: NOW,
}

const SPECS: Readonly<Record<number, Spec>> = {
  505: {
    name: 'Washing machine',
    type: 'washer',
    caps: ['device-status', 'running-state', 'power-meter'],
    features: [],
    slices: {
      'running-state': {
        running: true,
        since: NOW - 35 * 60_000,
        source: 'native',
        phase: 'Rinse',
        lastFetchedAt: NOW,
      },
      'power-meter': { power: 412, energy: 18.42, lastFetchedAt: NOW },
    },
  },
  521: {
    name: 'Living room AC',
    type: 'climate',
    caps: ['device-status', 'climate-control'],
    features: [],
    slices: {},
  },
  961: {
    name: 'Kitchen Echo',
    type: 'media-player',
    caps: ['media-player', 'device-status'],
    features: [DeviceFeature.MediaPlayerVolume, DeviceFeature.MediaPlayerMute],
    slices: { 'media-player': MEDIA },
  },
  971: {
    name: 'Washer plug',
    type: 'switch',
    caps: ['switch', 'power-meter', 'device-status'],
    features: [],
    slices: {
      switch: { on: true, lastChangedAt: NOW },
      'power-meter': { power: 38, energy: 2.1, lastFetchedAt: NOW },
    },
  },
}

export default defineFixtures({
  area: 'hero-model',
  description: 'Model-driven device hero: washer 505, AC 521, Echo 961, plug 971',
  handlers: {
    'heroLayout.getHeroModel': (i: { deviceId?: number; canActuate?: boolean }) => {
      const spec = SPECS[i.deviceId ?? 0]
      if (spec === undefined) return null
      return buildHeroModel({
        device: {
          id: i.deviceId ?? 0,
          type: spec.type,
          role: null,
          name: spec.name,
          online: true,
        },
        caps: spec.caps,
        features: spec.features,
        slices: spec.slices,
        now: NOW,
        remoteCommands: null,
        access: { canActuate: i.canActuate !== false },
      })
    },
  },
})
