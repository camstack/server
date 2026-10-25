/**
 * Source devices the generic compiler fixtures name. Not a new catalogue.
 */
import type { CompositionSourceRef } from '../../composition.js'

export interface FixtureFieldRead {
  readonly source: CompositionSourceRef
  readonly cap: string
  readonly fieldPath: string
  readonly valueKind: 'boolean' | 'number' | 'string'
}

export const FEEDER: CompositionSourceRef = {
  addonId: 'provider-homeassistant',
  stableId: 'ha:device:petkit-fresh-element-3',
}

export const BATTERY_NUMBER: FixtureFieldRead = {
  source: { addonId: 'provider-homeassistant', stableId: 'sensor.freshelement_3_battery' },
  cap: 'numeric-sensor',
  fieldPath: 'value',
  valueKind: 'number',
}

export const DESICCANT_STRING: FixtureFieldRead = {
  source: {
    addonId: 'provider-homeassistant',
    stableId: 'sensor.freshelement_3_desiccant_left_days',
  },
  cap: 'enum-sensor',
  fieldPath: 'value',
  valueKind: 'string',
}

export const DISHWASHER: CompositionSourceRef = { addonId: 'a', stableId: 'dish-1' }
export const SWITCH_REF: CompositionSourceRef = { addonId: 'b', stableId: 'sw-1' }

export const CAMERA_101: CompositionSourceRef = {
  addonId: 'provider-hikvision',
  stableId: 'mac-40acbf7be9f7',
}

export const DOORBELL_SWITCH: CompositionSourceRef = {
  addonId: 'provider-homeassistant',
  stableId: 'ha:ha_001:dev:bf38dbc6816ab9fdbd7f8f6b1eb4638b-switch.doorbell_bussano',
}

export const PIR_SENSOR = {
  addonId: 'provider-homeassistant',
  stableId: 'ha:pir',
  mode: 'in-addition',
} as const

export const GATE_SENSOR = {
  addonId: 'provider-zigbee',
  stableId: 'z:gate',
  mode: 'confirm',
} as const
