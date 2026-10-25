import { DeviceType, type ClimateControlStatus, type HvacMode } from '@camstack/types'
import type { ShcDeviceKind, ShcDeviceSummary, ShcRoomClimateState } from './shc-types.js'

const ROOM_CLIMATE_MODEL = 'ROOM_CLIMATE_CONTROL'

/** Classify a normalised device summary into an adoption / driver kind. */
export function classifyShcDevice(device: ShcDeviceSummary): ShcDeviceKind {
  const fromModel = shcKindForModel(device.deviceModel)
  if (fromModel !== 'unsupported') return fromModel
  if (device.services.includes('RoomClimateControl')) return 'room-climate'
  if (device.services.includes('PowerSwitch')) return 'switch'
  if (device.services.includes('TemperatureLevel') || device.services.includes('ValveTappet')) {
    return 'trv'
  }
  return 'unsupported'
}

export function shcKindForModel(deviceModel: string): ShcDeviceKind {
  if (deviceModel === ROOM_CLIMATE_MODEL) return 'room-climate'
  if (
    deviceModel === 'TWR_SWITCH' ||
    deviceModel === 'DIMMER_LIGHT' ||
    deviceModel === 'PLUG_COMPACT' ||
    deviceModel === 'PLUG_COMPACT_DUAL'
  ) {
    return 'switch'
  }
  if (
    deviceModel === 'HEATING_THERMOSTAT' ||
    deviceModel === 'RADIATOR_THERMOSTAT' ||
    deviceModel === 'TRV_GEN2_DUAL' ||
    deviceModel === 'TRV'
  ) {
    return 'trv'
  }
  return 'unsupported'
}

export function deviceTypeForShcKind(kind: Exclude<ShcDeviceKind, 'unsupported'>): DeviceType {
  switch (kind) {
    case 'room-climate':
      return DeviceType.Container
    case 'trv':
      return DeviceType.Thermostat
    case 'switch':
      return DeviceType.Switch
  }
}

export function capsForShcKind(kind: Exclude<ShcDeviceKind, 'unsupported'>): readonly string[] {
  switch (kind) {
    case 'room-climate':
      return ['climate-control']
    case 'switch':
      return ['switch']
    case 'trv':
      return ['temperature-sensor', 'battery', 'heating-valve']
  }
}

function mapShcModeToHvac(state: ShcRoomClimateState): HvacMode {
  const room = (state.roomControlMode ?? '').toUpperCase()
  if (room === 'OFF') return 'off'
  const upper = (state.operationMode ?? state.mode ?? '').toUpperCase()
  if (upper === 'OFF') return 'off'
  if (upper === 'AUTOMATIC' || upper === 'AUTO') return 'auto'
  if (upper.includes('COOL')) return 'cool'
  if (upper.includes('HEAT')) return 'heat'
  return 'heat'
}

const CLIMATE_MODES: readonly HvacMode[] = ['off', 'heat', 'auto']

/**
 * Setpoint ends the Smart Home Controller app enforces. RoomClimateControl
 * state does not carry them; a value present on the payload still wins.
 */
const SHC_SETPOINT_MIN = 5
const SHC_SETPOINT_MAX = 30

/** Map Bosch RoomClimateControl state JSON → CamStack climate-control slice. */
export function mapRoomClimateStateToSlice(state: ShcRoomClimateState): ClimateControlStatus {
  const now = Date.now()
  const mode = mapShcModeToHvac(state)
  return {
    mode,
    availableModes: [...CLIMATE_MODES],
    fanMode: '',
    availableFanModes: [],
    preset: '',
    availablePresets: [],
    target: state.setpointTemperature ?? null,
    targetHigh: null,
    targetLow: null,
    targetHumidity: null,
    currentTemp: state.temperature ?? null,
    currentHumidity: null,
    swingVertical: null,
    swingHorizontal: null,
    minTemp: state.minTemperature ?? SHC_SETPOINT_MIN,
    maxTemp: state.maxTemperature ?? SHC_SETPOINT_MAX,
    tempStep: 0.5,
    lastFetchedAt: now,
  }
}

/**
 * PUT bodies for a mode change, in order.
 * Off is `roomControlMode` alone — `operationMode: OFF` is rejected.
 * Heat and auto must turn heating on first; combining both fields while
 * the room is off returns WRONG_THERMOSTAT_GROUP_MODE.
 */
export function buildRoomClimateModeBodies(mode: HvacMode): readonly ShcRoomClimateState[] {
  if (mode === 'off') {
    return [{ '@type': 'climateControlState', roomControlMode: 'OFF' }]
  }
  const operationMode = mode === 'auto' ? 'AUTOMATIC' : 'MANUAL'
  return [
    { '@type': 'climateControlState', roomControlMode: 'HEATING' },
    { '@type': 'climateControlState', operationMode },
  ]
}

/** PowerSwitch on the controller is the string `ON` / `OFF`, not a boolean. */
export function readShcSwitchOn(state: {
  readonly switchState?: boolean | string
  readonly switchStates?: readonly { readonly switchState?: boolean | string }[]
}): boolean {
  if (isShcSwitchOn(state.switchState)) return true
  return isShcSwitchOn(state.switchStates?.[0]?.switchState)
}

function isShcSwitchOn(value: boolean | string | undefined): boolean {
  if (value === true) return true
  return typeof value === 'string' && value.toUpperCase() === 'ON'
}

export function buildPowerSwitchPutBody(on: boolean): {
  readonly '@type': string
  readonly switchState: 'ON' | 'OFF'
} {
  return {
    '@type': 'powerSwitchState',
    switchState: on ? 'ON' : 'OFF',
  }
}

/** Body for PUT RoomClimateControl/state when changing the setpoint. */
export function buildRoomClimatePutBody(input: { readonly target: number }): ShcRoomClimateState {
  return {
    '@type': 'climateControlState',
    setpointTemperature: input.target,
  }
}
