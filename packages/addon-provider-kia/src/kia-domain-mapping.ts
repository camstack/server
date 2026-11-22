import {
  locationFix,
  type ClimateControlStatus,
  type ConsumableItem,
  type ConsumablesStatus,
  type LocationStatus,
  type LockState,
  type VehicleStatus,
} from '@camstack/types'
import type { KiaVehicleState } from './kia-bridge.js'

/**
 * Maps what the maker cloud reported about a car onto the cap slices of the vehicle and its
 * accessories. A value the cloud did not report stays null (D393); a slice is never filled
 * with a plausible default.
 *
 * Each mapper takes the PREVIOUS slice so `lastChangedAt` moves only when something changed:
 * a read that found the same car is not a change.
 */

/** The cabin temperature range the worker accepts for a climate start, degrees Celsius. */
export const KIA_CLIMATE_MIN_C = 16
export const KIA_CLIMATE_MAX_C = 30
export const KIA_CLIMATE_STEP_C = 0.5

function withChangeTime<T extends { readonly lastChangedAt: number }>(
  next: T,
  previous: T | undefined,
): T {
  if (previous === undefined) return next
  const same =
    JSON.stringify({ ...next, lastChangedAt: 0 }) ===
    JSON.stringify({ ...previous, lastChangedAt: 0 })
  return same ? { ...next, lastChangedAt: previous.lastChangedAt } : next
}

export function vehicleStatusOf(
  state: KiaVehicleState,
  now: number,
  previous?: VehicleStatus,
): VehicleStatus {
  return withChangeTime(
    {
      odometer: state.odometerM,
      range: state.rangeM,
      engineOn: state.engineOn,
      doors: { ...state.doors },
      windows: { ...state.windows },
      trunkOpen: state.trunkOpen,
      hoodOpen: state.hoodOpen,
      sunroofOpen: state.sunroofOpen,
      tyreWarnings: { ...state.tyreWarnings },
      auxBatteryLevel: state.auxBatteryPct,
      // The cloud reports a percentage only; a voltage would be a guess.
      auxBatteryVoltage: null,
      reportedAt: state.reportedAtMs,
      lastChangedAt: now,
    },
    previous,
  )
}

export function locationStatusOf(
  state: KiaVehicleState,
  now: number,
  previous?: LocationStatus,
): LocationStatus {
  // The cloud gives a position and its time; heading, speed and accuracy are not in the API.
  return withChangeTime(
    locationFix({
      latitude: state.latitude,
      longitude: state.longitude,
      fixAt: state.fixAtMs,
      now,
    }),
    previous,
  )
}

type LowFlag = boolean | null

function levelOfFlag(flag: LowFlag): ConsumableItem['status'] {
  if (flag === null) return null
  return flag ? 'low' : 'ok'
}

function warningItem(key: string, label: string, flag: LowFlag): ConsumableItem | null {
  if (flag === null) return null
  return {
    key,
    label,
    level: null,
    status: levelOfFlag(flag),
    kind: 'supply',
    form: 'tank',
    lastResetAt: null,
    resettable: false,
  }
}

export function consumablesStatusOf(
  state: KiaVehicleState,
  now: number,
  previous?: ConsumablesStatus,
): ConsumablesStatus {
  const items: ConsumableItem[] = []
  if (state.fuelLevelPct !== null || state.fuelLow !== null) {
    items.push({
      key: 'fuel',
      label: 'Fuel',
      level: state.fuelLevelPct,
      status: levelOfFlag(state.fuelLow),
      kind: 'supply',
      form: 'tank',
      lastResetAt: null,
      resettable: false,
    })
  }
  if (state.nextServiceM !== null) {
    items.push({
      key: 'service',
      label: 'Next service',
      level: null,
      status: null,
      kind: 'wear',
      form: 'part',
      lastResetAt: null,
      resettable: false,
      remaining: { value: state.nextServiceM, kind: 'distance' },
    })
  }
  for (const item of [
    warningItem('washer-fluid', 'Washer fluid', state.washerFluidLow),
    warningItem('brake-fluid', 'Brake fluid', state.brakeFluidLow),
  ]) {
    if (item !== null) items.push(item)
  }
  if (state.smartKeyBatteryLow !== null) {
    items.push({
      key: 'key-fob-battery',
      label: 'Key fob battery',
      level: null,
      status: levelOfFlag(state.smartKeyBatteryLow),
      kind: 'wear',
      form: 'part',
      lastResetAt: null,
      resettable: false,
    })
  }
  return withChangeTime({ items, lastChangedAt: now }, previous)
}

/** The lock's state, or null while the cloud does not say (the slice is then left as it is). */
export function lockStateOf(state: KiaVehicleState): LockState | null {
  if (state.locked === null) return null
  return state.locked ? 'locked' : 'unlocked'
}

/**
 * The climate slice, or null while the cloud does not say whether it runs. The cloud gives no
 * heat or cool direction and no cabin temperature, so a running climate reads `auto` and the
 * current temperature stays unknown.
 */
export function climateStatusOf(state: KiaVehicleState, now: number): ClimateControlStatus | null {
  if (state.climateOn === null) return null
  return {
    mode: state.climateOn ? 'auto' : 'off',
    action: null,
    availableModes: ['off', 'auto'],
    fanMode: '',
    availableFanModes: [],
    preset: '',
    availablePresets: [],
    target: state.climateTargetC,
    targetHigh: null,
    targetLow: null,
    targetHumidity: null,
    currentTemp: null,
    currentHumidity: null,
    swingVertical: null,
    swingHorizontal: null,
    minTemp: KIA_CLIMATE_MIN_C,
    maxTemp: KIA_CLIMATE_MAX_C,
    tempStep: KIA_CLIMATE_STEP_C,
    lastFetchedAt: now,
  }
}
