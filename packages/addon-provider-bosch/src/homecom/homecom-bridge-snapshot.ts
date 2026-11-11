import type { HomeComSystemSnapshot } from './homecom-api-client.js'
import type {
  HomeComBridgeDeviceType,
  HomeComBridgeDhwCircuit,
  HomeComBridgeHeatingCircuit,
  HomeComBridgeReading,
  HomeComBridgeSetting,
  HomeComBridgeWrite,
} from './homecom-bridge.js'
import type { HomeComDhw, HomeComHeatingCircuit } from './homecom-domain-mapping.js'
import { hvacModesFromAllowed } from './homecom-domain-mapping.js'
import {
  acceptedOption,
  acceptedRange,
  circuitIsCooling,
  dhwTargetSetting,
  hasSystemDevice,
  heatPumpReadingFrom,
  HomeComHeatPumpRefusalError,
} from './homecom-heat-pump.js'
import { heatingCircuitName, HYDRONIC_MODES } from './homecom-pointt.js'

/**
 * The climate and water-heater view of a heat-pump gateway (k40, k30, icom), built from the
 * bridge reading, and the climate writes it accepts. The heat-pump view rides along when
 * the gateway has one (D1026).
 */

function numberValue(s: HomeComBridgeSetting | null): number | null {
  return s !== null && typeof s.value === 'number' ? s.value : null
}

function textValue(s: HomeComBridgeSetting | null): string | null {
  return s !== null && typeof s.value === 'string' && s.value.length > 0 ? s.value : null
}

type SetpointOp =
  | 'hcCoolingRoomSetpoint'
  | 'hcManualRoomSetpoint'
  | 'hcComfortSetpoint'
  | 'hcEcoSetpoint'

/** The setpoint a write lands on now, or why none can be named. */
type ActiveSetpoint =
  | {
      readonly kind: 'setting'
      readonly op: SetpointOp
      readonly what: string
      readonly setting: HomeComBridgeSetting | null
    }
  | { readonly kind: 'unknown'; readonly reason: string }

/**
 * Cooling writes the cooling setpoint; manual writes the manual room setpoint; auto writes the
 * temperature level (comfort or eco) the circuit runs on now. The library reads no active level
 * for a circuit, so it is the one level whose temperature equals the current room setpoint;
 * none or both matching is unknown, never a guess.
 */
function activeSetpoint(hc: HomeComBridgeHeatingCircuit): ActiveSetpoint {
  if (circuitIsCooling(hc)) {
    return {
      kind: 'setting',
      op: 'hcCoolingRoomSetpoint',
      what: `${hc.id} cooling setpoint`,
      setting: hc.coolingRoomSetpoint,
    }
  }
  if (textValue(hc.operationMode) !== 'auto') {
    return {
      kind: 'setting',
      op: 'hcManualRoomSetpoint',
      what: `${hc.id} setpoint`,
      setting: hc.manualRoomSetpoint,
    }
  }
  const current = numberValue(hc.currentRoomSetpoint)
  const comfort = current !== null && numberValue(hc.comfortSetpoint) === current
  const eco = current !== null && numberValue(hc.ecoSetpoint) === current
  if (comfort === eco) {
    return {
      kind: 'unknown',
      reason: `HomeCom ${hc.id}: the active level in auto mode cannot be told from the reading`,
    }
  }
  return comfort
    ? {
        kind: 'setting',
        op: 'hcComfortSetpoint',
        what: `${hc.id} comfort level`,
        setting: hc.comfortSetpoint,
      }
    : { kind: 'setting', op: 'hcEcoSetpoint', what: `${hc.id} eco level`, setting: hc.ecoSetpoint }
}

function climateCircuit(hc: HomeComBridgeHeatingCircuit): HomeComHeatingCircuit {
  const cooling = circuitIsCooling(hc)
  const active = activeSetpoint(hc)
  const limits = active.kind === 'setting' ? active.setting : null
  const modes = hvacModesFromAllowed(hc.operationMode?.allowed ?? [])
  return {
    id: hc.id,
    name: heatingCircuitName(hc.id, hc.name),
    operationMode: textValue(hc.operationMode) ?? 'off',
    setpoint: cooling
      ? (numberValue(hc.coolingRoomSetpoint) ?? numberValue(hc.currentRoomSetpoint))
      : (numberValue(hc.currentRoomSetpoint) ?? numberValue(hc.manualRoomSetpoint)),
    currentRoomTemp: hc.roomTemp,
    minTemp: limits?.min ?? null,
    maxTemp: limits?.max ?? null,
    currentHumidity: hc.humidity,
    season: cooling ? 'cooling' : textValue(hc.currentSuWiMode),
    fanMode: '',
    availableFanModes: [],
    swingVertical: null,
    swingHorizontal: null,
    availableModes: modes.length > 0 ? modes : [...HYDRONIC_MODES],
  }
}

function waterHeater(dhw: HomeComBridgeDhwCircuit): HomeComDhw {
  const target = dhwTargetSetting(dhw)
  const modes = dhw.operationMode?.allowed ?? []
  return {
    currentTemp: dhw.actualTemp,
    targetTemp: numberValue(target),
    operationMode: textValue(dhw.operationMode),
    availableModes: [...modes],
    minTemp: target?.min ?? null,
    maxTemp: target?.max ?? null,
    circuitId: dhw.id,
  }
}

export interface BridgeSnapshotInput {
  readonly gatewayId: string
  readonly deviceType: HomeComBridgeDeviceType
  readonly reading: HomeComBridgeReading
  readonly logDrop: (reason: string) => void
  /** A heat-source probe that failed transiently: it proves nothing, so it is named. */
  readonly logTransientProbe: (path: string) => void
}

export function bridgeSnapshot(input: BridgeSnapshotInput): HomeComSystemSnapshot {
  const { reading } = input
  const firstDhw = reading.dhwCircuits[0]
  if (reading.dhwCircuits.length > 1) {
    const extra = reading.dhwCircuits.slice(1).map((c) => c.id)
    input.logDrop(`extra DHW circuits are on the heat pump only: ${extra.join(', ')}`)
  }
  for (const [path, outcome] of Object.entries(reading.heatSourceProbe)) {
    if (outcome === 'transient') input.logTransientProbe(path)
  }
  const heatPump = heatPumpReadingFrom(reading)
  return {
    gateway: {
      gatewayId: input.gatewayId,
      name: input.gatewayId,
      model: input.deviceType,
    },
    circuits: reading.heatingCircuits.map(climateCircuit),
    dhw: firstDhw === undefined ? null : waterHeater(firstDhw),
    deviceType: input.deviceType,
    family: 'hydronic',
    bridge: reading,
    ...(hasSystemDevice(heatPump) ? { heatPump } : {}),
  }
}

// ── climate writes ──────────────────────────────────────────────────────

function findHc(reading: HomeComBridgeReading, circuitId: string): HomeComBridgeHeatingCircuit {
  const found = reading.heatingCircuits.find((c) => c.id === circuitId)
  if (found === undefined) {
    throw new HomeComHeatPumpRefusalError(`HomeCom has no heating circuit ${circuitId}`)
  }
  return found
}

function firstDhw(reading: HomeComBridgeReading): HomeComBridgeDhwCircuit {
  const found = reading.dhwCircuits[0]
  if (found === undefined) throw new HomeComHeatPumpRefusalError('HomeCom has no DHW circuit')
  return found
}

export function bridgeSetpointWrite(
  reading: HomeComBridgeReading,
  circuitId: string,
  temp: number,
): HomeComBridgeWrite {
  const active = activeSetpoint(findHc(reading, circuitId))
  if (active.kind === 'unknown') throw new HomeComHeatPumpRefusalError(active.reason)
  const value = acceptedRange(active.setting, active.what, temp)
  return { op: active.op, circuitId, value }
}

/** The gateway's token for an HVAC mode: heat is `manual`; cool is a heat/cool mode. */
function operationToken(mode: string): string {
  switch (mode) {
    case 'Heat':
    case 'heat':
      return 'manual'
    case 'Auto':
      return 'auto'
    case 'Off':
      return 'off'
    default:
      return mode
  }
}

export function bridgeModeWrite(
  reading: HomeComBridgeReading,
  circuitId: string,
  mode: string,
): HomeComBridgeWrite {
  const hc = findHc(reading, circuitId)
  if (mode === 'cool' || mode === 'Cool') {
    const allowed = hc.heatCoolMode?.allowed ?? []
    const token = allowed.includes('cool') ? 'cool' : 'cooling'
    const value = acceptedOption(hc.heatCoolMode, `${circuitId} heat/cool mode`, token)
    return { op: 'hcHeatCoolMode', circuitId, value }
  }
  const value = acceptedOption(hc.operationMode, `${circuitId} mode`, operationToken(mode))
  return { op: 'hcOperationMode', circuitId, value }
}

/** The hot-water target is the temperature of the level the tank runs on now. */
export function bridgeDhwTargetWrite(
  reading: HomeComBridgeReading,
  temp: number,
): HomeComBridgeWrite {
  const dhw = firstDhw(reading)
  const level = textValue(dhw.currentTemperatureLevel)
  if (level === null || level === 'off' || dhw.temperatureLevels[level] === undefined) {
    throw new HomeComHeatPumpRefusalError('HomeCom DHW: setpoint not supported')
  }
  const value = acceptedRange(dhw.temperatureLevels[level] ?? null, `${dhw.id} ${level}`, temp)
  return { op: 'dhwLevelTemp', circuitId: dhw.id, level, value }
}

export function bridgeDhwModeWrite(
  reading: HomeComBridgeReading,
  mode: string,
): HomeComBridgeWrite {
  const dhw = firstDhw(reading)
  const value = acceptedOption(dhw.operationMode, `${dhw.id} mode`, mode)
  return { op: 'dhwOperationMode', circuitId: dhw.id, value }
}
