/** Tutti2 devices: robots, media, home (see `hero-mockups.ts`). Slices carry only what the caps report. */
import { NOW } from './_time'
import type { MockupSpec } from './hero-mockups'

const MEDIA = {
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: null,
  isMuted: null,
  source: '',
  availableSources: [],
  currentMedia: null,
  position: null,
  duration: null,
  shuffle: null,
  repeat: null,
  positionUpdatedAt: null,
  lastChangedAt: NOW,
}

const item = (key: string, label: string, level: number) => ({
  key,
  label,
  level,
  status: 'ok',
  lastResetAt: null,
  resettable: true,
})

export const SPECS_TUTTI2: Readonly<Record<number, MockupSpec>> = {
  1201: {
    name: 'Robot piano terra',
    integration: 'Dreame',
    type: 'vacuum',
    provider: 'Dreame',
    caps: ['device-status', 'vacuum-control', 'consumables'],
    slices: {
      'vacuum-control': {
        state: 'cleaning',
        batteryLevel: 64,
        fanSpeed: 'Turbo',
        availableFanSpeeds: ['Silenzioso', 'Standard', 'Turbo'],
        progress: null,
        errorCode: null,
        errorLabel: null,
        lastChangedAt: NOW,
      },
      consumables: {
        items: [item('brush', 'Spazzola', 60), item('filter', 'Filtro', 80)],
        lastChangedAt: NOW,
      },
    },
  },
  1202: {
    name: 'Tagliaerba',
    integration: 'Dreame',
    type: 'lawn-mower',
    provider: 'Dreame',
    caps: ['device-status', 'lawn-mower-control', 'consumables'],
    slices: {
      'lawn-mower-control': {
        activity: 'mowing',
        batteryLevel: 58,
        progress: 61,
        currentCode: null,
        currentCodeLabel: null,
        severity: 'info',
        lastChangedAt: NOW,
      },
      consumables: { items: [item('blades', 'Lame', 72)], lastChangedAt: NOW },
    },
  },
  1203: {
    name: 'TV salone',
    integration: 'IR · Samsung',
    type: 'media-player',
    provider: 'IR',
    caps: ['device-status', 'media-player', 'remote'],
    remoteCommands: 12,
    slices: {
      'media-player': {
        ...MEDIA,
        state: 'on',
        source: 'HDMI 1',
        availableSources: ['HDMI 1', 'HDMI 2'],
      },
    },
  },
  1204: {
    name: 'Echo salone',
    integration: 'Alexa',
    type: 'media-player',
    provider: 'Alexa',
    caps: ['device-status', 'media-player'],
    slices: {
      'media-player': {
        ...MEDIA,
        state: 'playing',
        volumeLevel: 35,
        isMuted: false,
        currentMedia: { type: 'music', title: 'Radio 105' },
      },
    },
  },
  1205: {
    name: 'Videocamera ingresso',
    integration: 'Reolink',
    type: 'camera',
    provider: 'Reolink',
    caps: ['device-status', 'motion'],
    slices: {
      motion: { detected: true, lastDetectedAt: NOW - 4 * 60_000, autoClearAfterMs: null },
    },
  },
  1206: {
    name: 'Faro cortile',
    integration: 'Reolink',
    type: 'light',
    provider: 'Reolink',
    caps: ['device-status', 'switch', 'brightness'],
    slices: {
      switch: { on: true, lastChangedAt: NOW },
      brightness: { level: 80, lastChangedAt: NOW },
    },
  },
  1207: {
    name: 'Tapparella cucina',
    integration: 'Homematic',
    type: 'cover',
    provider: 'Homematic',
    caps: ['device-status', 'cover'],
    slices: { cover: { state: 'open', position: 60, tiltPosition: null, lastChangedAt: NOW } },
  },
  1208: {
    name: 'Serratura ingresso',
    integration: 'Nuki',
    type: 'lock',
    provider: 'Nuki',
    caps: ['device-status', 'lock-control', 'battery'],
    slices: {
      'lock-control': { state: 'locked', lastChangedAt: NOW - 2 * 3_600_000 },
      battery: { level: 18, charging: 'none', sleeping: false, lastUpdated: NOW },
    },
  },
  1209: {
    name: 'Alarm',
    integration: 'Casa',
    type: 'alarm-panel',
    provider: 'Casa',
    caps: ['device-status', 'alarm-panel'],
    slices: {
      'alarm-panel': {
        state: 'armed_home',
        targetMode: null,
        availableModes: ['home', 'away', 'night'],
        requiresCode: false,
        lastChangedAt: NOW - 3_600_000,
      },
    },
  },
  1210: {
    name: 'Sirena veranda',
    integration: 'Reolink',
    type: 'siren',
    provider: 'Reolink',
    caps: ['device-status', 'switch'],
    slices: { switch: { on: false, lastChangedAt: NOW } },
  },
}
