import { buildHeroModel, DeviceFeature, type HeroModel } from '@camstack/types'

import type { HeroLabels } from '../hero-labels'

const NOW = 1_700_000_000_000

/** English words the host would supply; specs pin what the card draws from them. */
export const TEST_LABELS: HeroLabels = {
  noValue: '–',
  callFailed: 'The device did not accept the command',
  historyTooltip: 'Opens the history of this device.',
  consumables: {
    label: 'Consumables',
    low: (count) => `${String(count)} low`,
    ok: 'OK',
    tooltip: 'Shows the level of each consumable and which ones need attention.',
  },
  power: {
    label: 'Power source',
    on: 'On',
    off: 'Off',
    tooltip: 'Opens a menu to cut or restore the power feeding this device, or to restart it.',
    tooltipReadOnly:
      'Whether the power source feeding this device is on. Your session cannot change it.',
  },
  confirm: {
    'off-while-running': { title: 'Turn off while running?', message: 'm', confirm: 'Turn off' },
    unlock: { title: 'Unlock?', message: 'The lock will open.', confirm: 'Unlock' },
    install: { title: 'Install the update?', message: 'm', confirm: 'Install' },
    press: { title: 'Run it now?', message: 'm', confirm: 'Run' },
  },
}

export function buildModel(
  type: string,
  caps: readonly string[],
  slices: Record<string, unknown>,
  canActuate = true,
  features: readonly string[] = [],
  role: string | null = null,
): HeroModel {
  return buildHeroModel({
    device: { id: 7, type, role, name: 'Device', online: true },
    caps,
    features,
    slices,
    now: NOW,
    remoteCommands: null,
    access: { canActuate },
  })
}

export const WASHER_SLICES: Record<string, unknown> = {
  'running-state': {
    running: true,
    since: NOW - 60_000,
    source: 'native',
    phase: 'Rinse',
    lastFetchedAt: NOW,
  },
  'power-meter': { power: 412, energy: 18.4, lastFetchedAt: NOW },
}

export const PLUG_SLICES: Record<string, unknown> = {
  switch: { on: true, lastChangedAt: NOW },
  'power-meter': { power: 38, energy: 2.1, lastFetchedAt: NOW },
}

export const MEDIA_SLICE: Record<string, unknown> = {
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

export const MEDIA_FEATURES: readonly string[] = [
  DeviceFeature.MediaPlayerVolume,
  DeviceFeature.MediaPlayerMute,
]
