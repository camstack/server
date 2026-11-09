/** Tutti3 devices: sensors, switch and the rest (see `hero-mockups.ts`). Slices carry only what the caps report. */
import { NOW } from './_time'
import type { MockupSpec } from './hero-mockups'

const battery = (level: number) => ({
  level,
  charging: 'none',
  sleeping: false,
  lastUpdated: NOW,
})

export const SPECS_TUTTI3: Readonly<Record<number, MockupSpec>> = {
  1301: {
    name: 'Temperatura interna',
    integration: 'Ecowitt',
    type: 'sensor',
    role: 'temperature-sensor',
    provider: 'Ecowitt',
    caps: ['device-status', 'temperature-sensor', 'humidity-sensor', 'pressure-sensor', 'battery'],
    slices: {
      'temperature-sensor': { temperature: 21.4, lastFetchedAt: NOW - 2 * 60_000 },
      'humidity-sensor': { humidity: 54, lastFetchedAt: NOW },
      'pressure-sensor': { pressure: 1013, lastFetchedAt: NOW },
      battery: battery(82),
    },
  },
  1302: {
    name: 'Porta lavanderia',
    integration: 'Zigbee',
    type: 'sensor',
    role: 'contact-sensor',
    provider: 'Zigbee',
    caps: ['device-status', 'contact', 'battery'],
    slices: {
      contact: { entryOpen: false, lastChangedAt: NOW - 3 * 3_600_000 },
      battery: battery(91),
    },
  },
  1303: {
    name: 'Presenza studio',
    integration: 'mmWave',
    type: 'presence',
    provider: 'mmWave',
    caps: ['device-status', 'presence'],
    slices: {
      presence: { state: 'home', location: null, gps: null, lastChangedAt: NOW - 30_000 },
    },
  },
  1304: {
    name: 'Ecowitt · weather-station',
    integration: 'Ecowitt',
    type: 'weather',
    provider: 'Ecowitt',
    caps: ['device-status', 'weather'],
    slices: {
      weather: {
        condition: 'partlycloudy',
        temperature: 17.8,
        humidity: 62,
        pressure: 1013,
        windSpeed: 12,
        windBearing: 45,
        lastFetchedAt: NOW,
      },
    },
  },
  1305: {
    name: 'Presa veranda',
    integration: 'Shelly',
    type: 'switch',
    role: 'outlet',
    provider: 'Shelly',
    caps: ['device-status', 'switch', 'power-meter'],
    slices: {
      switch: { on: true, lastChangedAt: NOW },
      'power-meter': { power: 1180, energy: 2.1, lastFetchedAt: NOW },
    },
  },
  1306: {
    name: 'Doorbell Restart',
    integration: 'Reolink',
    type: 'button',
    provider: 'Reolink',
    caps: ['device-status', 'button'],
    slices: {},
  },
  1307: {
    name: 'Firmware Videocamera ingresso',
    integration: 'Reolink',
    type: 'update',
    provider: 'Reolink',
    caps: ['device-status', 'update'],
    slices: {
      update: {
        currentVersion: 'v3.0.0.2356',
        availableVersion: 'v3.0.0.4110',
        updatable: true,
        state: null,
        inProgress: false,
      },
    },
  },
  1308: {
    name: 'Wrong code limit',
    integration: 'Nuki',
    type: 'control',
    provider: 'Nuki',
    caps: ['device-status', 'control'],
    slices: {
      control: {
        kind: 'numeric',
        value: 5,
        options: [],
        min: 1,
        max: 15,
        step: 1,
        lastChangedAt: NOW,
      },
    },
  },
  1309: {
    name: 'Home Assistant Events',
    integration: 'Home Assistant',
    type: 'event-emitter',
    provider: 'Home Assistant',
    caps: ['device-status', 'event-emitter'],
    slices: {
      'event-emitter': {
        eventTypes: ['doorbell', 'motion', 'zone'],
        lastEvent: {
          deviceId: 1309,
          eventType: 'zone',
          data: null,
          timestamp: NOW - 60_000,
          seq: 312,
        },
        eventCountSinceStart: 312,
      },
    },
  },
  1310: {
    name: 'Ecowitt Gateway',
    integration: 'Ecowitt',
    type: 'gateway',
    provider: 'Ecowitt',
    caps: ['device-status', 'group-status', 'network-link'],
    slices: {
      'group-status': { included: 14, excluded: 0, total: 14 },
      'network-link': { type: 'ethernet', signal: null, lastUpdated: NOW },
    },
  },
  1311: {
    name: 'send_raw_command',
    integration: 'Dreame',
    type: 'script',
    provider: 'Dreame',
    caps: ['device-status', 'script-runner'],
    slices: {
      'script-runner': {
        isRunning: false,
        lastRunAt: 0,
        lastRunSuccess: null,
        lastError: null,
        lastChangedAt: 0,
      },
    },
  },
}
