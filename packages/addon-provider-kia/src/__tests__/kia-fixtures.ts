import type { KiaVehicleState } from '../kia-bridge.js'

const UNKNOWN_CORNERS = { frontLeft: null, frontRight: null, rearLeft: null, rearRight: null }

/** Everything the cloud did not say: the worker's snapshot of a car that reports nothing. */
export function silentState(overrides: Partial<KiaVehicleState> = {}): KiaVehicleState {
  return {
    odometerM: null,
    rangeM: null,
    fuelLevelPct: null,
    fuelLow: null,
    engineOn: null,
    doors: { ...UNKNOWN_CORNERS },
    windows: { ...UNKNOWN_CORNERS },
    trunkOpen: null,
    hoodOpen: null,
    sunroofOpen: null,
    tyreWarnings: { ...UNKNOWN_CORNERS },
    auxBatteryPct: null,
    locked: null,
    climateOn: null,
    climateTargetC: null,
    washerFluidLow: null,
    brakeFluidLow: null,
    smartKeyBatteryLow: null,
    nextServiceM: null,
    latitude: null,
    longitude: null,
    fixAtMs: null,
    reportedAtMs: null,
    ...overrides,
  }
}

/** The state of the Sportage hybrid the Python fixture describes. */
export function sportageState(overrides: Partial<KiaVehicleState> = {}): KiaVehicleState {
  return silentState({
    odometerM: 18_432_700,
    rangeM: 812_000,
    fuelLevelPct: 64,
    fuelLow: false,
    engineOn: false,
    doors: { frontLeft: false, frontRight: false, rearLeft: false, rearRight: true },
    windows: { frontLeft: false, frontRight: false, rearLeft: false, rearRight: false },
    trunkOpen: false,
    hoodOpen: false,
    tyreWarnings: { frontLeft: false, frontRight: false, rearLeft: true, rearRight: false },
    auxBatteryPct: 87,
    locked: true,
    climateOn: false,
    climateTargetC: 21,
    washerFluidLow: false,
    brakeFluidLow: false,
    nextServiceM: 7_600_000,
    latitude: 45.4642,
    longitude: 9.19,
    fixAtMs: 1_795_335_300_000,
    reportedAtMs: 1_795_335_630_000,
    ...overrides,
  })
}
