/**
 * Message shapes copied from a running Zigbee2MQTT 2.x frontend socket (`ws://host:8080/api`):
 * the `exposes` of an Aqara contact sensor, an Aqara weather sensor, a Hue white-ambiance bulb, a
 * metering plug, a roller shutter, a lock, a TRV, a wireless button and a CO2 monitor, plus the
 * `bridge/*` envelopes the server pushes on connect.
 */
import { Z2mExposeSchema, type Z2mExpose } from '../../z2m-protocol.js'

const battery = {
  type: 'numeric',
  name: 'battery',
  property: 'battery',
  access: 1,
  unit: '%',
  value_min: 0,
  value_max: 100,
  category: 'diagnostic',
}
const linkquality = {
  type: 'numeric',
  name: 'linkquality',
  property: 'linkquality',
  access: 1,
  unit: 'lqi',
  value_min: 0,
  value_max: 255,
  category: 'diagnostic',
}
const voltage = {
  type: 'numeric',
  name: 'voltage',
  property: 'voltage',
  access: 1,
  unit: 'mV',
  category: 'diagnostic',
}

function parse(raw: readonly unknown[]): Z2mExpose[] {
  return raw.map((e) => Z2mExposeSchema.parse(e))
}

export const contactSensorExposes = parse([
  battery,
  {
    type: 'binary',
    name: 'contact',
    property: 'contact',
    access: 1,
    value_on: false,
    value_off: true,
  },
  linkquality,
  voltage,
])

export const weatherSensorExposes = parse([
  battery,
  { type: 'numeric', name: 'temperature', property: 'temperature', access: 1, unit: '°C' },
  { type: 'numeric', name: 'humidity', property: 'humidity', access: 1, unit: '%' },
  { type: 'numeric', name: 'pressure', property: 'pressure', access: 1, unit: 'hPa' },
  linkquality,
  voltage,
])

export const bulbExposes = parse([
  {
    type: 'light',
    features: [
      {
        type: 'binary',
        name: 'state',
        property: 'state',
        access: 7,
        value_on: 'ON',
        value_off: 'OFF',
        value_toggle: 'TOGGLE',
      },
      {
        type: 'numeric',
        name: 'brightness',
        property: 'brightness',
        access: 7,
        value_min: 0,
        value_max: 254,
      },
      {
        type: 'numeric',
        name: 'color_temp',
        property: 'color_temp',
        access: 7,
        unit: 'mired',
        value_min: 153,
        value_max: 500,
      },
    ],
  },
  { type: 'enum', name: 'effect', property: 'effect', access: 2, values: ['blink', 'breathe'] },
  linkquality,
])

export const meteringPlugExposes = parse([
  {
    type: 'switch',
    features: [
      {
        type: 'binary',
        name: 'state',
        property: 'state',
        access: 7,
        value_on: 'ON',
        value_off: 'OFF',
        value_toggle: 'TOGGLE',
      },
    ],
  },
  { type: 'numeric', name: 'power', property: 'power', access: 1, unit: 'W' },
  { type: 'numeric', name: 'energy', property: 'energy', access: 1, unit: 'kWh' },
  { type: 'numeric', name: 'voltage', property: 'voltage', access: 1, unit: 'V' },
  { type: 'numeric', name: 'current', property: 'current', access: 1, unit: 'A' },
  {
    type: 'binary',
    name: 'led_disabled_night',
    property: 'led_disabled_night',
    access: 7,
    value_on: true,
    value_off: false,
    category: 'config',
  },
  linkquality,
])

export const shutterExposes = parse([
  {
    type: 'cover',
    features: [
      {
        type: 'enum',
        name: 'state',
        property: 'state',
        access: 3,
        values: ['OPEN', 'CLOSE', 'STOP'],
      },
      {
        type: 'numeric',
        name: 'position',
        property: 'position',
        access: 7,
        unit: '%',
        value_min: 0,
        value_max: 100,
      },
    ],
  },
  battery,
  linkquality,
])

export const lockExposes = parse([
  {
    type: 'lock',
    features: [
      {
        type: 'binary',
        name: 'state',
        property: 'state',
        access: 3,
        value_on: 'LOCK',
        value_off: 'UNLOCK',
      },
      {
        type: 'enum',
        name: 'lock_state',
        property: 'lock_state',
        access: 1,
        values: ['not_fully_locked', 'locked', 'unlocked'],
      },
    ],
  },
  battery,
  linkquality,
])

export const trvExposes = parse([
  {
    type: 'climate',
    features: [
      {
        type: 'numeric',
        name: 'occupied_heating_setpoint',
        property: 'occupied_heating_setpoint',
        access: 7,
        unit: '°C',
        value_min: 5,
        value_max: 30,
        value_step: 0.5,
      },
      {
        type: 'numeric',
        name: 'local_temperature',
        property: 'local_temperature',
        access: 5,
        unit: '°C',
      },
      {
        type: 'enum',
        name: 'system_mode',
        property: 'system_mode',
        access: 7,
        values: ['off', 'heat', 'auto'],
      },
    ],
  },
  battery,
  linkquality,
])

export const buttonExposes = parse([
  battery,
  {
    type: 'enum',
    name: 'action',
    property: 'action',
    access: 1,
    values: ['single', 'double', 'hold'],
  },
  linkquality,
])

export const co2MonitorExposes = parse([
  { type: 'numeric', name: 'co2', property: 'co2', access: 1, unit: 'ppm' },
  { type: 'numeric', name: 'temperature', property: 'temperature', access: 1, unit: '°C' },
  { type: 'numeric', name: 'humidity', property: 'humidity', access: 1, unit: '%' },
  { type: 'numeric', name: 'illuminance', property: 'illuminance', access: 1, unit: 'lx' },
  linkquality,
])

/** `bridge/devices`: the coordinator and two end devices, as the server lists them. */
export const bridgeDevicesPayload = [
  {
    ieee_address: '0x00124b0000000000',
    type: 'Coordinator',
    network_address: 0,
    supported: true,
    friendly_name: 'Coordinator',
    disabled: false,
    definition: null,
    interviewing: false,
    interview_completed: true,
  },
  {
    ieee_address: '0x00158d0001a2b3c4',
    type: 'EndDevice',
    network_address: 4660,
    supported: true,
    friendly_name: 'door_front',
    disabled: false,
    power_source: 'Battery',
    definition: {
      model: 'MCCGQ11LM',
      vendor: 'Aqara',
      description: 'Door and window sensor',
      exposes: contactSensorExposes,
    },
    interviewing: false,
    interview_completed: true,
  },
  {
    ieee_address: '0x00158d0002d4e5f6',
    type: 'EndDevice',
    network_address: 22136,
    supported: true,
    friendly_name: 'weather_balcony',
    disabled: false,
    power_source: 'Battery',
    definition: {
      model: 'WSDCGQ11LM',
      vendor: 'Aqara',
      description: 'Temperature and humidity sensor',
      exposes: weatherSensorExposes,
    },
    interviewing: false,
    interview_completed: true,
  },
]

export const bridgeInfoPayload = {
  version: '2.1.3',
  commit: 'abcdef0',
  coordinator: {
    ieee_address: '0x00124b0000000000',
    type: 'zStack3x0',
    meta: { revision: 20220219 },
  },
  network: { channel: 15, pan_id: 6754, extended_pan_id: [1, 2, 3, 4, 5, 6, 7, 8] },
  log_level: 'info',
  permit_join: false,
  permit_join_end: null,
  config: { homeassistant: { enabled: false } },
}
