import type {
  HeatPumpCircuit,
  HeatPumpCircuitKind,
  HeatPumpOptionSetting,
  HeatPumpRangeSetting,
  HeatPumpStatus,
  HeatPumpSystem,
} from '@camstack/types'
import type {
  HomeComBridgeDhwCircuit,
  HomeComBridgeHeatingCircuit,
  HomeComBridgeReading,
  HomeComBridgeSetting,
  HomeComBridgeWrite,
  HomeComSystemOp,
} from './homecom-bridge.js'

/**
 * Heat-pump view of a hydronic gateway (D1026), read through the `homecom_alt` bridge.
 *
 * The resources and their payload shapes are the library's (`HomeComK40.async_update`), read
 * by the library's own device class. A resource the gateway did not answer, or
 * refused, is `null` (never 0), and the hero simply does not draw it.
 */

export type HomeComHeatPumpSetting = HomeComBridgeSetting

export interface HomeComHeatPumpCircuitReading {
  readonly id: string
  readonly kind: 'hc' | 'dhw'
  readonly currentTemp: number | null
  readonly targetTemp: number | null
  readonly operationMode: HomeComHeatPumpSetting | null
  readonly heatCoolMode: HomeComHeatPumpSetting | null
  readonly summerWinter: HomeComHeatPumpSetting | null
  readonly comfort: HomeComHeatPumpSetting | null
  readonly eco: HomeComHeatPumpSetting | null
  readonly maxFlow: HomeComHeatPumpSetting | null
  readonly level: HomeComHeatPumpSetting | null
  readonly chargeDuration: HomeComHeatPumpSetting | null
  readonly charge: HomeComHeatPumpSetting | null
}

export interface HomeComHeatPumpReading {
  readonly circuits: readonly HomeComHeatPumpCircuitReading[]
  /** `hs1/heatPumpType` (k40) or the heat source `type` (icom); null when not answered. */
  readonly heatPumpType: string | null
  readonly silent: HomeComHeatPumpSetting | null
  readonly away: HomeComHeatPumpSetting | null
  readonly additionalHeater: HomeComHeatPumpSetting | null
  readonly holiday: HomeComHeatPumpSetting | null
  readonly compressorPct: number | null
  readonly supply: number | null
  readonly return: number | null
  readonly outdoor: number | null
  readonly thermalKwh: number | null
  readonly electricalKwh: number | null
  readonly pressureBar: number | null
  readonly starts: number | null
}

export type HeatPumpSystemMode = keyof HeatPumpSystem
export type HeatPumpCircuitOption = 'operationMode' | 'heatCoolMode' | 'summerWinter'

/** A write the gateway would refuse, caught before it is sent. */
export class HomeComHeatPumpRefusalError extends Error {
  readonly name = 'HomeComHeatPumpRefusalError'
}

const COOLING_VALUES: readonly string[] = ['cool', 'cooling']

/** The current level's own temperature, or the gateway's current setpoint (icom). */
export function dhwTargetSetting(dhw: HomeComBridgeDhwCircuit): HomeComHeatPumpSetting | null {
  const level = dhw.currentTemperatureLevel?.value
  if (typeof level === 'string' && level !== 'off') {
    const own = dhw.temperatureLevels[level]
    if (own !== undefined) return own
  }
  return dhw.currentSetpoint
}

/** True when the circuit is cooling now: heat/cool mode or the season says so. */
export function circuitIsCooling(hc: HomeComBridgeHeatingCircuit): boolean {
  const mode = hc.heatCoolMode?.value
  const season = hc.currentSuWiMode?.value
  return (
    (typeof mode === 'string' && COOLING_VALUES.includes(mode)) ||
    (typeof season === 'string' && COOLING_VALUES.includes(season))
  )
}

function numberValue(s: HomeComHeatPumpSetting | null): number | null {
  return s !== null && typeof s.value === 'number' ? s.value : null
}

function hcReading(hc: HomeComBridgeHeatingCircuit): HomeComHeatPumpCircuitReading {
  const target = circuitIsCooling(hc)
    ? (numberValue(hc.coolingRoomSetpoint) ?? numberValue(hc.currentRoomSetpoint))
    : (numberValue(hc.currentRoomSetpoint) ?? numberValue(hc.manualRoomSetpoint))
  return {
    id: hc.id,
    kind: 'hc',
    currentTemp: hc.roomTemp,
    targetTemp: target,
    operationMode: hc.operationMode,
    heatCoolMode: hc.heatCoolMode,
    summerWinter: hc.suWiSwitchMode,
    comfort: hc.comfortSetpoint,
    eco: hc.ecoSetpoint,
    maxFlow: hc.maxFlowTemp,
    level: null,
    chargeDuration: null,
    charge: null,
  }
}

function dhwReading(dhw: HomeComBridgeDhwCircuit): HomeComHeatPumpCircuitReading {
  return {
    id: dhw.id,
    kind: 'dhw',
    currentTemp: dhw.actualTemp,
    targetTemp: numberValue(dhwTargetSetting(dhw)),
    operationMode: dhw.operationMode,
    heatCoolMode: null,
    summerWinter: null,
    comfort: null,
    eco: null,
    maxFlow: null,
    level: dhw.currentTemperatureLevel,
    chargeDuration: dhw.chargeDuration,
    charge: dhw.charge,
  }
}

export function heatPumpReadingFrom(bridge: HomeComBridgeReading): HomeComHeatPumpReading {
  const hs = bridge.heatSource
  return {
    circuits: [...bridge.heatingCircuits.map(hcReading), ...bridge.dhwCircuits.map(dhwReading)],
    heatPumpType: hs.heatPumpType,
    silent: bridge.system.silent,
    away: bridge.system.away,
    additionalHeater: bridge.system.additionalHeater,
    holiday: bridge.system.holiday,
    compressorPct: hs.modulationPct,
    supply: hs.supplyTemp,
    return: hs.returnTemp,
    outdoor: hs.outdoorTemp,
    thermalKwh: hs.thermalKwh,
    electricalKwh: hs.electricalKwh,
    pressureBar: hs.pressureBar,
    starts: hs.starts,
  }
}

/**
 * True when the gateway should be offered as a system device (`hp:0`).
 *
 * Only evidence a gas boiler on the same controller family cannot give counts: a heat-pump
 * type on the heat source, the silent mode or the additional heater (heat-pump-only
 * resources), or a heating circuit that can cool. Away, holiday, flow, return, modulation,
 * pressure and starts are answered by a boiler too.
 */
export function hasSystemDevice(reading: HomeComHeatPumpReading): boolean {
  if (reading.heatPumpType !== null) return true
  if (reading.silent !== null || reading.additionalHeater !== null) return true
  return reading.circuits.some((c) => c.kind === 'hc' && offersCooling(c.heatCoolMode))
}

function offersCooling(setting: HomeComHeatPumpSetting | null): boolean {
  if (setting === null) return false
  const value = setting.value
  if (typeof value === 'string' && COOLING_VALUES.includes(value)) return true
  return setting.allowed.some((allowed) => COOLING_VALUES.includes(allowed))
}

// ── mapping to the cap slice ────────────────────────────────────────────

export function heatPumpStatusFrom(reading: HomeComHeatPumpReading, now: number): HeatPumpStatus {
  return {
    circuits: reading.circuits.map(circuitOf),
    system: {
      silent: optionOf(reading.silent),
      away: optionOf(reading.away),
      additionalHeater: optionOf(reading.additionalHeater),
      holiday: optionOf(reading.holiday),
    },
    // The HomeCom cloud publishes no instantaneous thermal or electrical power, so the
    // instant COP stays unknown rather than being derived from energy totals.
    power: {
      thermalW: null,
      electricalW: null,
      compressorPct: reading.compressorPct,
    },
    temperatures: {
      supply: reading.supply,
      return: reading.return,
      outdoor: reading.outdoor,
    },
    energy: {
      thermalKwh: reading.thermalKwh,
      electricalKwh: reading.electricalKwh,
    },
    waterPressureBar: reading.pressureBar,
    starts: reading.starts,
    lastFetchedAt: now,
  }
}

function circuitOf(c: HomeComHeatPumpCircuitReading): HeatPumpCircuit {
  const kind = kindOf(c)
  return {
    id: c.id,
    kind,
    label: labelOf(c),
    icon: kind === 'dhw' ? 'droplets' : kind === 'cooling' ? 'snowflake' : 'flame',
    currentTemp: c.currentTemp,
    targetTemp: c.targetTemp,
    mode: modeValue(c.operationMode),
    active: null,
    operationMode: optionOf(c.operationMode),
    heatCoolMode: optionOf(c.heatCoolMode),
    summerWinter: optionOf(c.summerWinter),
    comfortSetpoint: rangeOf(c.comfort),
    ecoSetpoint: rangeOf(c.eco),
    maxFlowTemp: rangeOf(c.maxFlow),
    temperatureLevel: optionOf(c.level),
    chargeDuration: rangeOf(c.chargeDuration),
    extraHotWater: c.charge === null ? null : textOf(c.charge) === 'start',
  }
}

function kindOf(c: HomeComHeatPumpCircuitReading): HeatPumpCircuitKind {
  if (c.kind === 'dhw') return 'dhw'
  const mode = textOf(c.heatCoolMode)
  return mode !== null && COOLING_VALUES.includes(mode) ? 'cooling' : 'heating'
}

function labelOf(c: HomeComHeatPumpCircuitReading): string {
  const n = c.id.replace(/^\D+/, '')
  if (c.kind === 'dhw') return n === '1' || n === '' ? 'Hot water' : `Hot water ${n}`
  return n === '' ? 'Heating circuit' : `Heating circuit ${n}`
}

function textOf(s: HomeComHeatPumpSetting | null): string | null {
  return s !== null && typeof s.value === 'string' && s.value.length > 0 ? s.value : null
}

/**
 * A mode the gateway answered with an empty value is off (or "none" when the
 * gateway did not list off). A mode it did not answer at all stays null.
 */
function modeValue(s: HomeComHeatPumpSetting | null): string | null {
  if (s === null || typeof s.value !== 'string') return null
  if (s.value.length > 0) return s.value
  return s.allowed.includes('off') ? 'off' : 'none'
}

function optionOf(s: HomeComHeatPumpSetting | null): HeatPumpOptionSetting | null {
  if (s === null) return null
  return { value: modeValue(s), allowed: [...s.allowed] }
}

function rangeOf(s: HomeComHeatPumpSetting | null): HeatPumpRangeSetting | null {
  if (s === null) return null
  return { value: numberValue(s), min: s.min, max: s.max, step: null }
}

// ── writes ──────────────────────────────────────────────────────────────

function requireCircuit(reading: HomeComHeatPumpReading, circuitId: string, want: 'hc' | 'dhw') {
  const found = reading.circuits.find((c) => c.id === circuitId && c.kind === want)
  if (found === undefined) {
    throw new HomeComHeatPumpRefusalError(`HomeCom heat pump has no ${want} circuit ${circuitId}`)
  }
  return found
}

/** The accepted value of an option setting, or a refusal naming why the gateway would refuse. */
export function acceptedOption(
  s: HomeComHeatPumpSetting | null,
  what: string,
  mode: string,
): string {
  if (s === null) {
    throw new HomeComHeatPumpRefusalError(`HomeCom heat pump: ${what} is not available`)
  }
  if (s.writeable === false || s.allowed.length === 0) {
    throw new HomeComHeatPumpRefusalError(`HomeCom heat pump: ${what} is read-only on this gateway`)
  }
  if (!s.allowed.includes(mode)) {
    throw new HomeComHeatPumpRefusalError(
      `HomeCom heat pump: "${mode}" is not an accepted value of ${what} (${s.allowed.join(', ')})`,
    )
  }
  return mode
}

/** The value of a range write, within the limits the gateway gave, or a refusal. */
export function acceptedRange(
  s: HomeComHeatPumpSetting | null,
  what: string,
  value: number,
): number {
  if (s === null) {
    throw new HomeComHeatPumpRefusalError(`HomeCom heat pump: ${what} is not available`)
  }
  if (s.writeable === false) {
    throw new HomeComHeatPumpRefusalError(`HomeCom heat pump: ${what} is read-only on this gateway`)
  }
  if (!Number.isFinite(value)) {
    throw new HomeComHeatPumpRefusalError(`HomeCom heat pump: ${what} needs a finite number`)
  }
  if (s.min === null || s.max === null) {
    throw new HomeComHeatPumpRefusalError(
      `HomeCom heat pump: ${what} has no limits from the gateway`,
    )
  }
  if (value < s.min || value > s.max) {
    throw new HomeComHeatPumpRefusalError(
      `HomeCom heat pump: ${value} is outside ${what} limits ${s.min}..${s.max}`,
    )
  }
  return value
}

const SYSTEM_OPS: Readonly<Record<HeatPumpSystemMode, HomeComSystemOp>> = {
  silent: 'silentMode',
  away: 'awayMode',
  additionalHeater: 'additionalHeaterMode',
  holiday: 'holidayMode',
}

export function systemModeWrite(
  reading: HomeComHeatPumpReading,
  which: HeatPumpSystemMode,
  mode: string,
): HomeComBridgeWrite {
  return {
    op: SYSTEM_OPS[which],
    value: acceptedOption(reading[which], `${which} mode`, mode),
  }
}

const CIRCUIT_OPTION_OPS = {
  operationMode: 'hcOperationMode',
  heatCoolMode: 'hcHeatCoolMode',
  summerWinter: 'hcSuWiSwitchMode',
} as const

export function circuitOptionWrite(
  reading: HomeComHeatPumpReading,
  circuitId: string,
  which: HeatPumpCircuitOption,
  mode: string,
): HomeComBridgeWrite {
  const circuit = requireCircuit(reading, circuitId, 'hc')
  return {
    op: CIRCUIT_OPTION_OPS[which],
    circuitId,
    value: acceptedOption(circuit[which], `${circuitId} ${which}`, mode),
  }
}

const DHW_OPTION_OPS = {
  operationMode: 'dhwOperationMode',
  level: 'dhwTemperatureLevel',
} as const

export function dhwOptionWrite(
  reading: HomeComHeatPumpReading,
  circuitId: string,
  which: 'operationMode' | 'level',
  mode: string,
): HomeComBridgeWrite {
  const circuit = requireCircuit(reading, circuitId, 'dhw')
  return {
    op: DHW_OPTION_OPS[which],
    circuitId,
    value: acceptedOption(circuit[which], `${circuitId} ${which}`, mode),
  }
}

const CIRCUIT_RANGE_OPS = {
  comfort: 'hcComfortSetpoint',
  eco: 'hcEcoSetpoint',
  maxFlow: 'hcMaxFlowTemp',
} as const

export function circuitRangeWrite(
  reading: HomeComHeatPumpReading,
  circuitId: string,
  which: 'comfort' | 'eco' | 'maxFlow',
  value: number,
): HomeComBridgeWrite {
  const circuit = requireCircuit(reading, circuitId, 'hc')
  return {
    op: CIRCUIT_RANGE_OPS[which],
    circuitId,
    value: acceptedRange(circuit[which], `${circuitId} ${which}`, value),
  }
}

export function dhwChargeDurationWrite(
  reading: HomeComHeatPumpReading,
  circuitId: string,
  minutes: number,
): HomeComBridgeWrite {
  const circuit = requireCircuit(reading, circuitId, 'dhw')
  return {
    op: 'dhwChargeDuration',
    circuitId,
    value: acceptedRange(circuit.chargeDuration, `${circuitId} charge duration`, minutes),
  }
}

export function extraHotWaterWrite(
  reading: HomeComHeatPumpReading,
  circuitId: string,
): HomeComBridgeWrite {
  const charge = requireCircuit(reading, circuitId, 'dhw').charge
  return {
    op: 'dhwCharge',
    circuitId,
    value: acceptedOption(charge, `${circuitId} extra hot water`, 'start'),
  }
}
