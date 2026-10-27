// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-history-catalog.ts
/* eslint-disable */

import type {
  CapabilityHistoryField,
  CapabilityHistoryItems,
} from '../capabilities/capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Cap history catalog, projected from every `*.cap.ts` `history` block.
 * 42 caps with series (77 series), 33 caps answered `'none'`.
 * Field keys are `runtimeState` paths (`a.b` into fixed objects only).
 */
export const HISTORY_CATALOG: Readonly<Record<string, Readonly<Record<string, CapabilityHistoryField>>>> = {
  'air-quality-sensor': {
    'co2Ppm': { kind: 'gauge', unit: 'ppm', deadband: 5 },
    'vocPpb': { kind: 'gauge', unit: 'ppb', deadband: 5 },
    'pm25': { kind: 'gauge', unit: 'µg/m³', deadband: 1 },
    'pm10': { kind: 'gauge', unit: 'µg/m³', deadband: 1 },
    'aqi': { kind: 'gauge', unit: 'count', deadband: 1 },
  },
  'alarm-panel': {
    'state': { kind: 'enum', values: ['disarmed', 'armed_home', 'armed_away', 'armed_night', 'armed_vacation', 'armed_custom_bypass', 'arming', 'disarming', 'pending', 'triggered'] },
  },
  'ambient-light-sensor': {
    'lux': { kind: 'gauge', unit: 'lx', deadbandPct: 10, minIntervalMs: 60000 },
  },
  'battery': {
    'percentage': { kind: 'gauge', unit: '%' },
    'volts': { kind: 'gauge', unit: 'V' },
  },
  'binary': {
    'on': { kind: 'boolean' },
  },
  'brightness': {
    'percentage': { kind: 'gauge', unit: '%', minIntervalMs: 0 },
  },
  'carbon-monoxide': {
    'detected': { kind: 'boolean' },
  },
  'climate-control': {
    'currentTemp': { kind: 'gauge', unit: '°C', deadband: 0.1 },
    'currentHumidity': { kind: 'gauge', unit: '%', deadband: 0.5 },
    'target': { kind: 'gauge', unit: '°C', minIntervalMs: 0 },
    'targetHigh': { kind: 'gauge', unit: '°C', minIntervalMs: 0 },
    'targetLow': { kind: 'gauge', unit: '°C', minIntervalMs: 0 },
  },
  'connectivity': {
    'connected': { kind: 'boolean' },
  },
  'contact': {
    'entryOpen': { kind: 'boolean' },
  },
  'cover': {
    'position': { kind: 'gauge', unit: '%', minIntervalMs: 0 },
  },
  'device-status': {
    'online': { kind: 'boolean' },
  },
  'dishwasher': {
    'progressPercent': { kind: 'gauge', unit: '%', deadband: 2 },
    'state': { kind: 'enum', values: ['idle', 'running', 'paused', 'finished', 'error', 'unavailable'] },
    'operationState': { kind: 'enum', values: ['Inactive', 'Ready', 'DelayedStart', 'Run', 'Pause', 'ActionRequired', 'Finished', 'Error', 'Aborting'] },
    'remainingSeconds': { kind: 'gauge', unit: 's', minIntervalMs: 60000 },
    'doorOpen': { kind: 'boolean' },
    'powerOn': { kind: 'boolean' },
  },
  'enum-sensor': {
    'value': { kind: 'enum', skipWhenSet: 'timestamp' },
  },
  'fan-control': {
    'percentage': { kind: 'gauge', unit: '%', minIntervalMs: 0 },
    'oscillating': { kind: 'boolean' },
  },
  'flood': {
    'flooded': { kind: 'boolean' },
  },
  'gas': {
    'detected': { kind: 'boolean' },
  },
  'heating-valve': {
    'position': { kind: 'gauge', unit: '%', deadband: 1 },
  },
  'humidifier': {
    'currentHumidity': { kind: 'gauge', unit: '%', deadband: 0.5 },
    'on': { kind: 'boolean' },
  },
  'humidity-sensor': {
    'percent': { kind: 'gauge', unit: '%', deadband: 0.5 },
  },
  'lawn-mower-control': {
    'batteryLevel': { kind: 'gauge', unit: '%', deadband: 2 },
  },
  'lock-control': {
    'state': { kind: 'enum', values: ['locked', 'unlocked', 'locking', 'unlocking', 'jammed'] },
  },
  'media-player': {
    'volumeLevel': { kind: 'gauge', unit: '%', deadband: 1 },
    'isMuted': { kind: 'boolean' },
  },
  'meter': {
    'value': { kind: 'counter', deadband: 0.001, minIntervalMs: 60000 },
  },
  'motion': {
    'detected': { kind: 'boolean', excludeDeviceTypes: [DeviceType.Camera] },
  },
  'network-link': {
    'signalPercent': { kind: 'gauge', unit: '%', deadband: 3, minIntervalMs: 60000 },
    'rssiDbm': { kind: 'gauge', unit: 'dBm', deadband: 2, minIntervalMs: 60000 },
  },
  'numeric-sensor': {
    'value': { kind: 'gauge', minIntervalMs: 30000 },
  },
  'pet-feeder': {
    'foodLevel': { kind: 'gauge' },
    'bowlFood': { kind: 'gauge' },
    'food1': { kind: 'gauge' },
    'food2': { kind: 'gauge' },
    'batteryPower': { kind: 'gauge', unit: '%', deadband: 2 },
    'desiccantLeftDays': { kind: 'gauge', unit: 's' },
  },
  'power-meter': {
    'watts': { kind: 'gauge', unit: 'W', deadband: 1, minIntervalMs: 30000 },
    'kwhTotal': { kind: 'counter', unit: 'kWh', deadband: 0.01, minIntervalMs: 60000 },
    'volts': { kind: 'gauge', unit: 'V', deadband: 1, minIntervalMs: 30000 },
    'amps': { kind: 'gauge', unit: 'A', deadband: 0.05, minIntervalMs: 30000 },
    'va': { kind: 'gauge', unit: 'VA', deadband: 1, minIntervalMs: 30000 },
    'powerFactor': { kind: 'gauge', unit: 'ratio', deadband: 0.01, minIntervalMs: 60000 },
  },
  'presence': {
    'batteryPercent': { kind: 'gauge', unit: '%', deadband: 1 },
  },
  'pressure-sensor': {
    'hpa': { kind: 'gauge', unit: 'hPa', deadband: 0.1 },
  },
  'running-state': {
    'running': { kind: 'boolean' },
  },
  'smoke': {
    'detected': { kind: 'boolean' },
  },
  'stream-params': {
    'main.bitrate': { kind: 'gauge', unit: 'kbps' },
    'main.framerate': { kind: 'gauge', unit: 'fps' },
    'sub.bitrate': { kind: 'gauge', unit: 'kbps' },
    'sub.framerate': { kind: 'gauge', unit: 'fps' },
  },
  'switch': {
    'on': { kind: 'boolean' },
  },
  'tamper': {
    'tampered': { kind: 'boolean' },
  },
  'temperature-sensor': {
    'celsius': { kind: 'gauge', unit: '°C', deadband: 0.1 },
  },
  'vacuum-control': {
    'batteryLevel': { kind: 'gauge', unit: '%', deadband: 2 },
  },
  'valve': {
    'position': { kind: 'gauge', unit: '%', minIntervalMs: 0 },
  },
  'vibration': {
    'detected': { kind: 'boolean' },
  },
  'water-heater': {
    'currentTemp': { kind: 'gauge', unit: '°C', deadband: 0.5 },
    'targetTemp': { kind: 'gauge', unit: '°C', minIntervalMs: 0 },
  },
  'weather': {
    'temperature': { kind: 'gauge', unit: '°C', deadband: 0.2 },
    'humidity': { kind: 'gauge', unit: '%', deadband: 1 },
    'pressure': { kind: 'gauge', unit: 'hPa', deadband: 0.5 },
    'windSpeed': { kind: 'gauge', unit: 'm/s', deadband: 0.5 },
  },
}

/**
 * Keyed-array series (D917), projected from every `history.items` block:
 * 1 caps (3 item fields). The item key is the series SCOPE;
 * the series key is `cap:<capName>.<path>[].<field>`.
 */
export const HISTORY_ITEM_CATALOG: Readonly<Record<string, CapabilityHistoryItems>> = {
  'consumables': {
    path: 'items',
    key: 'key',
    label: 'label',
    fields: {
      'level': { kind: 'gauge', unit: '%', deadband: 2, displayName: 'Level' },
      'status': { kind: 'enum', displayName: 'Status', values: ['ok', 'low', 'empty', 'full', 'replace'] },
      'remaining.value': { kind: 'gauge', deadband: 1, displayName: 'Remaining' },
    },
  },
}

/** Caps that declared `history: 'none'`, sorted. */
export const HISTORY_NONE_CAPS: readonly string[] = [
  'audio-metrics',
  'automation-control',
  'camera-streams',
  'color',
  'control',
  'day-night',
  'device-discovery',
  'doorbell',
  'event-emitter',
  'feature-probe',
  'group-active',
  'group-commands',
  'group-status',
  'image',
  'image-settings',
  'intercom',
  'motion-trigger',
  'motion-zones',
  'native-object-detection',
  'navigation',
  'notifier',
  'privacy-mask',
  'ptz-autotrack',
  'recording-onboard',
  'recording-signal',
  'scene-monitor',
  'script-runner',
  'stream-catalog',
  'stream-signals',
  'update',
  'zone-analytics',
  'zone-rules',
  'zones',
]

/** The series specs of `capName`; empty for a `'none'` cap or an unknown one. */
export function historyFieldsFor(capName: string): Readonly<Record<string, CapabilityHistoryField>> {
  return HISTORY_CATALOG[capName] ?? {}
}
