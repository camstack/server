// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-history-catalog.ts
/* eslint-disable */

import type {
  CapabilityHistoryField,
  CapabilityHistoryItems,
  CapabilityHistoryPrimary,
} from '../capabilities/capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Cap history catalog, projected from every `*.cap.ts` `history` block.
 * 53 caps with series (167 series), 36 caps answered `'none'`.
 * Field keys are `runtimeState` paths (`a.b` into fixed objects only).
 */
export const HISTORY_CATALOG: Readonly<Record<string, Readonly<Record<string, CapabilityHistoryField>>>> = {
  'air-quality-sensor': {
    'co2': { kind: 'gauge', unit: 'ppm', deadband: 5 },
    'voc': { kind: 'gauge', unit: 'ppb', deadband: 5 },
    'pm25': { group: 'particulates', kind: 'gauge', unit: 'µg/m³', deadband: 1 },
    'pm10': { group: 'particulates', kind: 'gauge', unit: 'µg/m³', deadband: 1 },
    'aqi': { kind: 'gauge', unit: 'count', deadband: 1 },
  },
  'alarm-panel': {
    'state': { kind: 'enum', values: ['disarmed', 'armed_home', 'armed_away', 'armed_night', 'armed_vacation', 'armed_custom_bypass', 'arming', 'disarming', 'pending', 'triggered'] },
  },
  'ambient-light-sensor': {
    'illuminance': { kind: 'gauge', unit: 'lx', deadbandPct: 10, minIntervalMs: 60000 },
  },
  'battery': {
    'charging': { kind: 'enum', values: ['dc', 'solar', 'none', 'unknown'] },
    'chargeState': { kind: 'enum', values: ['charging', 'full', 'idle', 'unknown'] },
    'level': { kind: 'gauge', unit: '%' },
    'voltage': { kind: 'gauge', unit: 'V' },
    'temperatureC': { kind: 'gauge', unit: '°C' },
  },
  'binary': {
    'on': { kind: 'boolean' },
  },
  'brightness': {
    'level': { kind: 'gauge', unit: '%', minIntervalMs: 0 },
  },
  'carbon-monoxide': {
    'detected': { kind: 'boolean' },
  },
  'climate-control': {
    'mode': { kind: 'enum', values: ['off', 'heat', 'cool', 'auto', 'heat_cool', 'fan_only', 'dry'] },
    'currentTemp': { group: 'temperature', kind: 'gauge', unit: '°C', deadband: 0.1 },
    'currentHumidity': { kind: 'gauge', unit: '%', deadband: 0.5 },
    'target': { group: 'temperature', kind: 'gauge', unit: '°C', minIntervalMs: 0 },
    'targetHigh': { group: 'target-range', kind: 'gauge', unit: '°C', minIntervalMs: 0 },
    'targetLow': { group: 'target-range', kind: 'gauge', unit: '°C', minIntervalMs: 0 },
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
    'filterCleaningDue': { kind: 'boolean' },
    'machineCareDue': { kind: 'boolean' },
    'progress': { kind: 'gauge', unit: '%', deadband: 2 },
    'state': { kind: 'enum', values: ['idle', 'running', 'paused', 'finished', 'error', 'unavailable'] },
    'operationState': { kind: 'enum', values: ['Inactive', 'Ready', 'DelayedStart', 'Run', 'Pause', 'ActionRequired', 'Finished', 'Error', 'Aborting'] },
    'remaining': { kind: 'gauge', unit: 's', minIntervalMs: 60000 },
    'doorOpen': { kind: 'boolean' },
    'powerOn': { kind: 'boolean' },
  },
  'do-not-disturb': {
    'enabled': { kind: 'boolean' },
  },
  'energy-system': {
    'solar.powerW': { group: 'power-flow', kind: 'gauge', unit: 'W', deadband: 50, displayName: 'Solar power' },
    'solar.energyKwh': { kind: 'counter', unit: 'kWh', displayName: 'Solar energy' },
    'grid.powerW': { group: 'power-flow', kind: 'gauge', unit: 'W', deadband: 50, displayName: 'Grid power' },
    'grid.importKwh': { kind: 'counter', unit: 'kWh', displayName: 'Grid import' },
    'grid.exportKwh': { kind: 'counter', unit: 'kWh', displayName: 'Grid export' },
    'house.powerW': { group: 'power-flow', kind: 'gauge', unit: 'W', deadband: 50, displayName: 'House power' },
    'house.energyKwh': { kind: 'counter', unit: 'kWh', displayName: 'House energy' },
    'heatPump.powerW': { group: 'power-flow', kind: 'gauge', unit: 'W', deadband: 50, displayName: 'Heat pump power' },
    'heatPump.energyKwh': { kind: 'counter', unit: 'kWh', displayName: 'Heat pump energy' },
    'storage.stateOfChargePct': { kind: 'gauge', unit: '%', deadband: 1, displayName: 'Storage charge' },
    'storage.storedKwh': { kind: 'gauge', unit: 'kWh', deadband: 0.05, displayName: 'Stored energy' },
    'storage.capacityKwh': { kind: 'gauge', unit: 'kWh', deadband: 0.1, displayName: 'Storage capacity' },
    'storage.powerW': { group: 'power-flow', kind: 'gauge', unit: 'W', deadband: 50, displayName: 'Storage power' },
    'storage.chargedKwh': { kind: 'counter', unit: 'kWh', displayName: 'Storage charged' },
    'storage.dischargedKwh': { kind: 'counter', unit: 'kWh', displayName: 'Storage discharged' },
    'storage.healthPct': { kind: 'gauge', unit: '%', deadband: 1, displayName: 'Storage health' },
  },
  'enum-sensor': {
    'value': { kind: 'enum', skipWhenSet: 'timestamp' },
  },
  'fan-control': {
    'speed': { kind: 'gauge', unit: '%', minIntervalMs: 0 },
    'oscillating': { kind: 'boolean' },
  },
  'flood': {
    'flooded': { kind: 'boolean' },
  },
  'gas': {
    'detected': { kind: 'boolean' },
  },
  'heat-pump-status': {
    'power.thermalW': { group: 'power', kind: 'gauge', unit: 'W', deadband: 50, displayName: 'Thermal power' },
    'power.electricalW': { group: 'power', kind: 'gauge', unit: 'W', deadband: 50, displayName: 'Electrical power' },
    'power.compressorPct': { kind: 'gauge', unit: '%', deadband: 2, displayName: 'Compressor' },
    'temperatures.supply': { group: 'loop', kind: 'gauge', unit: '°C', deadband: 0.5, displayName: 'Supply' },
    'temperatures.return': { group: 'loop', kind: 'gauge', unit: '°C', deadband: 0.5, displayName: 'Return' },
    'temperatures.outdoor': { kind: 'gauge', unit: '°C', deadband: 0.5, displayName: 'Outdoor' },
    'energy.thermalKwh': { kind: 'counter', unit: 'kWh', displayName: 'Thermal energy' },
    'energy.electricalKwh': { kind: 'counter', unit: 'kWh', displayName: 'Electrical energy' },
  },
  'heating-valve': {
    'position': { kind: 'gauge', unit: '%', deadband: 1 },
  },
  'humidifier': {
    'currentHumidity': { kind: 'gauge', unit: '%', deadband: 0.5 },
    'on': { kind: 'boolean' },
  },
  'humidity-sensor': {
    'humidity': { kind: 'gauge', unit: '%', deadband: 0.5 },
  },
  'intercom': {
    'talking': { kind: 'boolean' },
  },
  'lawn-mower-control': {
    'activity': { kind: 'enum', values: ['idle', 'mowing', 'paused', 'docked', 'error'] },
    'batteryLevel': { kind: 'gauge', unit: '%', deadband: 2 },
  },
  'location': {
    'latitude': { group: 'position', kind: 'gauge', unit: '°', deadband: 0.0002, displayName: 'Latitude' },
    'longitude': { group: 'position', kind: 'gauge', unit: '°', deadband: 0.0002, displayName: 'Longitude' },
    'speed': { kind: 'gauge', unit: 'm/s', deadband: 0.5, displayName: 'Speed' },
  },
  'lock-control': {
    'state': { kind: 'enum', values: ['locked', 'unlocked', 'locking', 'unlocking', 'jammed', 'door-open'] },
  },
  'low-power-sleep': {
    'sleeping': { kind: 'boolean' },
  },
  'media-player': {
    'state': { kind: 'enum', values: ['off', 'on', 'idle', 'playing', 'paused', 'buffering', 'standby'] },
    'volumeLevel': { kind: 'gauge', unit: '%', deadband: 1 },
    'isMuted': { kind: 'boolean' },
  },
  'meter': {
    'value': { kind: 'counter', deadband: 0.001, minIntervalMs: 60000 },
  },
  'motion': {
    'detected': { kind: 'boolean', excludeDeviceTypes: [DeviceType.Camera] },
  },
  'navigation': {
    'mode': { kind: 'enum', values: ['idle', 'cleaning', 'spot', 'following', 'goto', 'returning', 'paused', 'unknown'] },
  },
  'network-link': {
    'type': { kind: 'enum', values: ['wifi', 'ethernet', 'cellular', 'unknown'] },
    'signal': { kind: 'gauge', unit: '%', deadband: 3, minIntervalMs: 60000 },
    'rssi': { kind: 'gauge', unit: 'dBm', deadband: 2, minIntervalMs: 60000 },
  },
  'numeric-sensor': {
    'value': { kind: 'gauge', minIntervalMs: 30000 },
  },
  'pet-feeder': {
    'lowFood': { kind: 'boolean' },
    'feeding': { kind: 'boolean' },
    'eating': { kind: 'boolean' },
    'foodLevel': { kind: 'gauge' },
    'bowlFood': { kind: 'gauge' },
    'food1': { kind: 'gauge' },
    'food2': { kind: 'gauge' },
    'batteryPower': { kind: 'gauge', unit: '%', deadband: 2 },
    'desiccantLeftDays': { kind: 'gauge', unit: 's' },
  },
  'pet-fountain': {
    'empty': { kind: 'boolean' },
    'waterLevel': { kind: 'gauge', unit: '%', deadband: 1 },
    'waterVolume': { kind: 'gauge', unit: 'L' },
  },
  'power-meter': {
    'power': { kind: 'gauge', unit: 'W', deadband: 1, minIntervalMs: 30000 },
    'energy': { kind: 'counter', unit: 'kWh', deadband: 0.01, minIntervalMs: 60000 },
    'voltage': { kind: 'gauge', unit: 'V', deadband: 1, minIntervalMs: 30000 },
    'current': { kind: 'gauge', unit: 'A', deadband: 0.05, minIntervalMs: 30000 },
    'apparentPower': { kind: 'gauge', unit: 'VA', deadband: 1, minIntervalMs: 30000 },
    'powerFactor': { kind: 'gauge', unit: 'ratio', deadband: 0.01, minIntervalMs: 60000 },
  },
  'presence': {
    'state': { kind: 'enum' },
  },
  'pressure-sensor': {
    'pressure': { kind: 'gauge', unit: 'hPa', deadband: 0.1 },
  },
  'running-state': {
    'running': { kind: 'boolean' },
  },
  'smoke': {
    'detected': { kind: 'boolean' },
  },
  'stream-params': {
    'main.bitrate': { group: 'bitrate', kind: 'gauge', unit: 'kbps' },
    'main.framerate': { group: 'framerate', kind: 'gauge', unit: 'fps' },
    'sub.bitrate': { group: 'bitrate', kind: 'gauge', unit: 'kbps' },
    'sub.framerate': { group: 'framerate', kind: 'gauge', unit: 'fps' },
  },
  'switch': {
    'on': { kind: 'boolean' },
  },
  'tamper': {
    'tampered': { kind: 'boolean' },
  },
  'temperature-sensor': {
    'temperature': { kind: 'gauge', unit: '°C', deadband: 0.1 },
  },
  'vacuum-control': {
    'state': { kind: 'enum', values: ['idle', 'cleaning', 'paused', 'returning', 'docked', 'drying', 'error'] },
    'batteryLevel': { kind: 'gauge', unit: '%', deadband: 2 },
  },
  'valve': {
    'position': { kind: 'gauge', unit: '%', minIntervalMs: 0 },
  },
  'vehicle': {
    'odometer': { kind: 'counter', unit: 'm', displayName: 'Distance driven' },
    'range': { kind: 'gauge', unit: 'm', deadband: 1000, displayName: 'Range' },
    'engineOn': { kind: 'boolean', displayName: 'Engine' },
    'auxBatteryLevel': { kind: 'gauge', unit: '%', deadband: 1, displayName: '12 V battery' },
    'auxBatteryVoltage': { kind: 'gauge', unit: 'V', deadband: 0.1, displayName: '12 V voltage' },
    'doors.frontLeft': { kind: 'boolean', displayName: 'Front left door' },
    'doors.frontRight': { kind: 'boolean', displayName: 'Front right door' },
    'doors.rearLeft': { kind: 'boolean', displayName: 'Rear left door' },
    'doors.rearRight': { kind: 'boolean', displayName: 'Rear right door' },
    'tyreWarnings.frontLeft': { kind: 'boolean', displayName: 'Front left tyre warning' },
    'tyreWarnings.frontRight': { kind: 'boolean', displayName: 'Front right tyre warning' },
    'tyreWarnings.rearLeft': { kind: 'boolean', displayName: 'Rear left tyre warning' },
    'tyreWarnings.rearRight': { kind: 'boolean', displayName: 'Rear right tyre warning' },
    'trunkOpen': { kind: 'boolean', displayName: 'Trunk' },
    'hoodOpen': { kind: 'boolean', displayName: 'Hood' },
  },
  'vibration': {
    'detected': { kind: 'boolean' },
  },
  'water-heater': {
    'away': { kind: 'boolean' },
    'currentTemp': { group: 'temperature', kind: 'gauge', unit: '°C', deadband: 0.5 },
    'targetTemp': { group: 'temperature', kind: 'gauge', unit: '°C', minIntervalMs: 0 },
  },
  'weather': {
    'temperature': { kind: 'gauge', unit: '°C', deadband: 0.2 },
    'humidity': { kind: 'gauge', unit: '%', deadband: 1 },
    'pressure': { kind: 'gauge', unit: 'hPa', deadband: 0.5 },
    'windSpeed': { kind: 'gauge', unit: 'm/s', deadband: 0.5 },
  },
  'weather-station': {
    'temperature': { group: 'temperature', kind: 'gauge', unit: '°C', deadband: 0.1 },
    'humidity': { kind: 'gauge', unit: '%', deadband: 1 },
    'pressure': { kind: 'gauge', unit: 'hPa', deadband: 0.2 },
    'windSpeed': { group: 'wind-speed', kind: 'gauge', unit: 'm/s', deadband: 0.2 },
    'windGust': { group: 'wind-speed', kind: 'gauge', unit: 'm/s', deadband: 0.2 },
    'windBearing': { group: 'wind-bearing', kind: 'gauge', unit: '°', deadband: 5 },
    'rainRate': { kind: 'gauge', unit: 'mm/h', deadband: 0.1 },
    'rainDaily': { kind: 'gauge', unit: 'mm', deadband: 0.1 },
    'rainEvent': { kind: 'gauge', unit: 'mm', deadband: 0.1 },
    'uv': { kind: 'gauge', unit: 'index', deadband: 0.1 },
    'solarRadiation': { kind: 'gauge', unit: 'W/m²', deadband: 5 },
    'dewPoint': { group: 'temperature', kind: 'gauge', unit: '°C', deadband: 0.1 },
    'feelsLike': { group: 'temperature', kind: 'gauge', unit: '°C', deadband: 0.1 },
    'vpd': { kind: 'gauge', unit: 'kPa', deadband: 0.05 },
    'windGustMax': { group: 'wind-speed', kind: 'gauge', unit: 'm/s', deadband: 0.2 },
    'windBearingAvg': { group: 'wind-bearing', kind: 'gauge', unit: '°', deadband: 5 },
    'rain24h': { kind: 'gauge', unit: 'mm', deadband: 0.1 },
    'rainWeekly': { kind: 'gauge', unit: 'mm', deadband: 0.1 },
    'rainMonthly': { kind: 'gauge', unit: 'mm', deadband: 0.1 },
    'rainYearly': { kind: 'gauge', unit: 'mm', deadband: 0.1 },
  },
  'workload': {
    'resources.temperature': { kind: 'gauge', unit: '°C', deadband: 0.5, displayName: 'Temperature' },
    'state': { kind: 'enum', values: ['running', 'paused', 'stopped', 'starting', 'stopping', 'crashed'] },
    'resources.cpuPercent': { kind: 'gauge', unit: '%', deadband: 2, displayName: 'CPU' },
    'resources.memoryUsedBytes': { kind: 'gauge', unit: 'bytes', displayName: 'Memory used' },
    'resources.memoryPercent': { kind: 'gauge', unit: '%', deadband: 2, displayName: 'Memory' },
    'resources.netRxKbps': { group: 'network', kind: 'gauge', unit: 'kbps', displayName: 'Network received' },
    'resources.netTxKbps': { group: 'network', kind: 'gauge', unit: 'kbps', displayName: 'Network sent' },
  },
}

/**
 * Keyed-array series (D917), projected from every `history.items` block:
 * 2 caps (6 item fields). The item key is the series SCOPE;
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
  'heat-pump-status': {
    path: 'circuits',
    key: 'id',
    label: 'label',
    fields: {
      'currentTemp': { kind: 'gauge', unit: '°C', deadband: 0.5, displayName: 'Temperature' },
      'targetTemp': { kind: 'gauge', unit: '°C', minIntervalMs: 0, displayName: 'Setpoint' },
      'mode': { kind: 'enum', displayName: 'Mode' },
    },
  },
}

/**
 * The series a device card trends, per cap (`history.primary` + `history.priority`):
 * 8 caps. The card shows the primary of the enabled cap with the highest priority.
 */
export const HISTORY_PRIMARY: Readonly<Record<string, CapabilityHistoryPrimary>> = {
  'climate-control': { field: 'currentTemp', priority: 70 },
  'energy-system': { field: 'house.powerW', priority: 50 },
  'humidity-sensor': { field: 'humidity', priority: 90 },
  'power-meter': { field: 'power', priority: 80 },
  'temperature-sensor': { field: 'temperature', priority: 100 },
  'vehicle': { field: 'range', priority: 30 },
  'weather-station': { field: 'temperature', priority: 60 },
  'workload': { field: 'resources.cpuPercent', priority: 40 },
}

/** Caps that declared `history: 'none'`, sorted. */
export const HISTORY_NONE_CAPS: readonly string[] = [
  'audio-metrics',
  'automation-control',
  'camera-streams',
  'color',
  'control',
  'day-night',
  'doorbell',
  'error',
  'event-emitter',
  'feature-probe',
  'group-active',
  'group-commands',
  'group-status',
  'image',
  'image-settings',
  'ir-transmitter',
  'motion-trigger',
  'motion-zones',
  'native-object-detection',
  'notifier',
  'power-source',
  'privacy-mask',
  'ptz-autotrack',
  'pump-cycle',
  'recording-onboard',
  'recording-signal',
  'scene-monitor',
  'script-runner',
  'siren',
  'stream-catalog',
  'stream-signals',
  'timed-run',
  'update',
  'zone-analytics',
  'zone-rules',
  'zones',
]

/** The series specs of `capName`; empty for a `'none'` cap or an unknown one. */
export function historyFieldsFor(capName: string): Readonly<Record<string, CapabilityHistoryField>> {
  return HISTORY_CATALOG[capName] ?? {}
}
