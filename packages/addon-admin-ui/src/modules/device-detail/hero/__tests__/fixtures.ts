import { buildHeroModel, DeviceFeature, type HeroModel } from '@camstack/types'

const NOW = 1_700_000_000_000

export function buildModel(
  type: string,
  caps: readonly string[],
  slices: Record<string, unknown>,
  canActuate = true,
  features: readonly string[] = [],
): HeroModel {
  return buildHeroModel({
    device: { id: 7, type, role: null, name: 'Device', online: true },
    caps,
    features,
    slices,
    now: NOW,
    remoteCommands: null,
    access: { canActuate },
  })
}

export const WASHER_SLICES = {
  'running-state': {
    running: true,
    since: NOW - 60_000,
    source: 'native',
    phase: 'Rinse',
    lastFetchedAt: NOW,
  },
  'power-meter': { power: 412, energy: 18.4, lastFetchedAt: NOW },
}

export const PLUG_SLICES = {
  switch: { on: true, lastChangedAt: NOW },
  'power-meter': { power: 38, energy: 2.1, lastFetchedAt: NOW },
}

export const MEDIA_SLICE = {
  state: 'playing',
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: 40,
  isMuted: false,
  source: 'HDMI 1',
  availableSources: ['HDMI 1', 'HDMI 2'],
  currentMedia: { type: 'music', title: 'Song', artist: 'Band' },
  position: null,
  duration: null,
  shuffle: null,
  repeat: null,
  positionUpdatedAt: null,
  lastChangedAt: 0,
}

export const MEDIA_FEATURES = [DeviceFeature.MediaPlayerVolume, DeviceFeature.MediaPlayerMute]
