import type { ClimateControlStatus, HvacMode } from '@camstack/types'
import type { HomeComBridgeWrite, HomeComBridgeZone } from './homecom-bridge.js'
import {
  climateSliceFromCircuit,
  hvacModeOf,
  hvacModesFromAllowed,
  type HomeComHeatingCircuit,
} from './homecom-domain-mapping.js'
import { acceptedOption, acceptedRange, HomeComHeatPumpRefusalError } from './homecom-heat-pump.js'

/**
 * A zone ("Zone configuration") as a climate child. It owns no value: every field is read
 * from the bridge zone on each call, and a write is checked against the limits that same
 * zone reported.
 */

export const ZONE_NATIVE_PREFIX = 'zone:'

export function zoneNativeId(zoneId: string): string {
  return `${ZONE_NATIVE_PREFIX}${zoneId}`
}

function zoneAsCircuit(zone: HomeComBridgeZone): HomeComHeatingCircuit {
  const mode = zone.userMode
  const manual = zone.manualTemp
  const manualValue = manual !== null && typeof manual.value === 'number' ? manual.value : null
  return {
    id: zone.id,
    name: `Zone ${zone.id}`,
    operationMode: typeof mode?.value === 'string' ? mode.value : 'off',
    setpoint: zone.setpointTemp ?? manualValue,
    currentRoomTemp: zone.currentTemp,
    minTemp: manual?.min ?? null,
    maxTemp: manual?.max ?? null,
    season: null,
    availableModes: hvacModesFromAllowed(mode?.allowed ?? []),
  }
}

export function zoneClimateSlice(zone: HomeComBridgeZone, now: number): ClimateControlStatus {
  return climateSliceFromCircuit(zoneAsCircuit(zone), now)
}

/** The token the zone lists for an HVAC mode (`manual` for heat, `clock` for auto). */
function tokenFor(zone: HomeComBridgeZone, mode: HvacMode): string {
  const allowed = zone.userMode?.allowed ?? []
  return allowed.find((token) => hvacModeOf(token) === mode) ?? mode
}

export function zoneModeWrite(zone: HomeComBridgeZone, mode: HvacMode): HomeComBridgeWrite {
  return {
    op: 'zoneUserMode',
    circuitId: zone.id,
    value: acceptedOption(zone.userMode, `${zone.id} mode`, tokenFor(zone, mode)),
  }
}

export function zoneTargetWrite(zone: HomeComBridgeZone, temp: number): HomeComBridgeWrite {
  const current = typeof zone.userMode?.value === 'string' ? hvacModeOf(zone.userMode.value) : null
  if (current !== 'heat') {
    throw new HomeComHeatPumpRefusalError(
      `HomeCom ${zone.id}: the temperature is set in manual mode only`,
    )
  }
  return {
    op: 'zoneManualTemp',
    circuitId: zone.id,
    value: acceptedRange(zone.manualTemp, `${zone.id} temperature`, temp),
  }
}
