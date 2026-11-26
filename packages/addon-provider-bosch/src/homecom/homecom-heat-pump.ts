import { DeviceType } from '@camstack/types'
import type {
  HeatPumpCircuit,
  HeatPumpCircuitKind,
  HeatPumpDemand,
  HeatPumpOptionSetting,
  HeatPumpRangeSetting,
  HeatPumpStatus,
  HeatPumpSystem,
  IconKey,
} from '@camstack/types'
import type {
  HomeComBridgeDhwCircuit,
  HomeComBridgeFault,
  HomeComBridgeHeatingCircuit,
  HomeComBridgeReading,
  HomeComBridgeSolarCircuit,
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
  readonly kind: 'hc' | 'dhw' | 'solar'
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
  readonly controlType: HomeComHeatPumpSetting | null
  /** Hot water: the temperature each level heats to; null on every other circuit. */
  readonly levels: Readonly<Record<string, HomeComHeatPumpSetting>> | null
  readonly tankBottomTemp: number | null
  readonly maxCylinderTemp: number | null
  readonly yieldKwh: number | null
}

/** One registry child of the heat-pump device, as the identity lookup reads it. */
export interface HeatPumpChildInfo {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly config: Readonly<Record<string, unknown>>
}

/** The registry child that owns a circuit: its id and its registry name. */
export interface HeatPumpCircuitIdentity {
  readonly deviceId: number
  readonly label: string
}

export interface HomeComHeatPumpReading {
  readonly circuits: readonly HomeComHeatPumpCircuitReading[]
  /** `hs1/heatPumpType` (k40) or the heat source `type` (icom); null when not answered. */
  readonly heatPumpType: string | null
  /**
   * A heat-pump-only heat-source resource exists although its value is not readable: the
   * gateway answered it, or refused it (403/500). A 404 or a transient failure is not this.
   */
  readonly heatSourceRefused: boolean
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
  /** Total working time of the heat source, seconds. */
  readonly workingTimeS: number | null
  readonly heatDemand: HeatPumpDemand | null
  readonly compressorRunning: boolean | null
  /** The gateway notifications; null when the read was refused or failed (D393). */
  readonly faults: readonly HomeComBridgeFault[] | null
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
    controlType: hc.controlType,
    levels: null,
    tankBottomTemp: null,
    maxCylinderTemp: null,
    yieldKwh: null,
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
    controlType: null,
    levels: dhw.temperatureLevels,
    tankBottomTemp: null,
    maxCylinderTemp: null,
    yieldKwh: null,
  }
}

function solarReading(sc: HomeComBridgeSolarCircuit): HomeComHeatPumpCircuitReading {
  return {
    id: sc.id,
    kind: 'solar',
    currentTemp: sc.collectorTemp,
    targetTemp: null,
    operationMode: null,
    heatCoolMode: null,
    summerWinter: null,
    comfort: null,
    eco: null,
    maxFlow: null,
    level: null,
    chargeDuration: null,
    charge: null,
    controlType: null,
    levels: null,
    tankBottomTemp: sc.tankBottomTemp,
    maxCylinderTemp: sc.maxCylinderTemp,
    yieldKwh: sc.yieldKwh,
  }
}

export function heatPumpReadingFrom(bridge: HomeComBridgeReading): HomeComHeatPumpReading {
  const hs = bridge.heatSource
  return {
    circuits: [
      ...bridge.heatingCircuits.map(hcReading),
      ...bridge.dhwCircuits.map(dhwReading),
      ...bridge.solarCircuits.map(solarReading),
    ],
    heatPumpType: hs.heatPumpType,
    heatSourceRefused: Object.values(bridge.heatSourceProbe).some(
      (outcome) => outcome === 'answered' || outcome === 'refused',
    ),
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
    workingTimeS: hs.workingTimeS,
    heatDemand: hs.heatDemand,
    compressorRunning: hs.compressorRunning,
    faults: bridge.faults,
  }
}

/**
 * True when the gateway should be offered as a system device (`hp:0`).
 *
 * Only evidence a gas boiler on the same controller family cannot give counts: a heat-pump
 * type on the heat source, a heat-pump-only heat-source resource the gateway refuses (403/500,
 * never a 404 or a transient failure), the silent mode or the additional heater
 * (heat-pump-only resources), or a heating circuit that can cool. Away, holiday, flow, return, modulation,
 * pressure and starts are answered by a boiler too.
 */
export function hasSystemDevice(reading: HomeComHeatPumpReading): boolean {
  if (reading.heatPumpType !== null || reading.heatSourceRefused) return true
  if (reading.silent !== null || reading.additionalHeater !== null) return true
  return reading.circuits.some((c) => c.kind === 'hc' && offersCooling(c.heatCoolMode))
}

function offersCooling(setting: HomeComHeatPumpSetting | null): boolean {
  if (setting === null) return false
  const value = setting.value
  if (typeof value === 'string' && COOLING_VALUES.includes(value)) return true
  return setting.allowed.some((allowed) => COOLING_VALUES.includes(allowed))
}

/**
 * Which registry child owns which circuit: a climate child names its circuit in
 * `config.circuitId`; the water heater child is the first hot-water circuit's. The circuit
 * keeps no copy of the child's values, only its id and name.
 */
export function circuitIdentitiesFrom(
  children: readonly HeatPumpChildInfo[],
  circuits: readonly HomeComHeatPumpCircuitReading[],
): ReadonlyMap<string, HeatPumpCircuitIdentity> {
  const found = new Map<string, HeatPumpCircuitIdentity>()
  const firstDhw = circuits.find((c) => c.kind === 'dhw')
  for (const circuit of circuits) {
    const child = children.find((c) => {
      if (circuit.kind === 'hc')
        return c.type === DeviceType.Climate && c.config['circuitId'] === circuit.id
      return circuit.kind === 'dhw' && circuit === firstDhw && c.type === DeviceType.WaterHeater
    })
    if (child !== undefined) found.set(circuit.id, { deviceId: child.id, label: child.name })
  }
  return found
}

// ── mapping to the cap slice ────────────────────────────────────────────

export function heatPumpStatusFrom(
  reading: HomeComHeatPumpReading,
  now: number,
  identities: ReadonlyMap<string, HeatPumpCircuitIdentity> = new Map(),
): HeatPumpStatus {
  return {
    circuits: reading.circuits.map((c) => circuitOf(c, identities.get(c.id))),
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
    workingTime: reading.workingTimeS,
    heatDemand: reading.heatDemand,
    heatSourceType: reading.heatPumpType,
    compressorRunning: reading.compressorRunning,
    lastFetchedAt: now,
  }
}

const CIRCUIT_ICONS: Readonly<Record<HeatPumpCircuitKind, IconKey>> = {
  heating: 'flame',
  cooling: 'snowflake',
  dhw: 'droplets',
  solar: 'sun',
}

function circuitOf(
  c: HomeComHeatPumpCircuitReading,
  identity: HeatPumpCircuitIdentity | undefined,
): HeatPumpCircuit {
  const kind = kindOf(c)
  return {
    id: c.id,
    deviceId: identity?.deviceId ?? null,
    kind,
    // The child's registry name when the circuit has one: there is no second name.
    label: identity?.label ?? labelOf(c),
    icon: CIRCUIT_ICONS[kind],
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
    levelTemperatures:
      c.levels === null
        ? null
        : Object.fromEntries(Object.entries(c.levels).map(([level, s]) => [level, rangeOf(s)])),
    controlType: optionOf(c.controlType),
    tankBottomTemp: c.tankBottomTemp,
    maxCylinderTemp: c.maxCylinderTemp,
    yieldKwh: c.yieldKwh,
  }
}

function kindOf(c: HomeComHeatPumpCircuitReading): HeatPumpCircuitKind {
  if (c.kind === 'dhw') return 'dhw'
  if (c.kind === 'solar') return 'solar'
  const mode = textOf(c.heatCoolMode)
  return mode !== null && COOLING_VALUES.includes(mode) ? 'cooling' : 'heating'
}

function labelOf(c: HomeComHeatPumpCircuitReading): string {
  const n = c.id.replace(/^\D+/, '')
  if (c.kind === 'solar') return n === '1' || n === '' ? 'Solar' : `Solar ${n}`
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

function rangeOf(s: HomeComHeatPumpSetting): HeatPumpRangeSetting
function rangeOf(s: HomeComHeatPumpSetting | null): HeatPumpRangeSetting | null
function rangeOf(s: HomeComHeatPumpSetting | null): HeatPumpRangeSetting | null {
  if (s === null) return null
  return { value: numberValue(s), min: s.min, max: s.max, step: s.step }
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

/** The gateway lists "no holiday" as the empty value, not as `off`. */
function holidayOffValue(
  which: HeatPumpSystemMode,
  setting: HomeComHeatPumpSetting | null,
  mode: string,
): string {
  if (which !== 'holiday' || mode !== 'off' || setting === null) return mode
  return !setting.allowed.includes('off') && setting.allowed.includes('') ? '' : mode
}

export function systemModeWrite(
  reading: HomeComHeatPumpReading,
  which: HeatPumpSystemMode,
  mode: string,
): HomeComBridgeWrite {
  const setting = reading[which]
  return {
    op: SYSTEM_OPS[which],
    value: acceptedOption(setting, `${which} mode`, holidayOffValue(which, setting, mode)),
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

export function circuitControlTypeWrite(
  reading: HomeComHeatPumpReading,
  circuitId: string,
  controlType: string,
): HomeComBridgeWrite {
  const circuit = requireCircuit(reading, circuitId, 'hc')
  return {
    op: 'hcControlType',
    circuitId,
    value: acceptedOption(circuit.controlType, `${circuitId} control type`, controlType),
  }
}

export function dhwLevelTempWrite(
  reading: HomeComHeatPumpReading,
  circuitId: string,
  level: string,
  temp: number,
): HomeComBridgeWrite {
  const circuit = requireCircuit(reading, circuitId, 'dhw')
  const setting = circuit.levels?.[level]
  if (setting === undefined) {
    throw new HomeComHeatPumpRefusalError(
      `HomeCom heat pump: ${circuitId} has no level "${level}" to set a temperature on`,
    )
  }
  return {
    op: 'dhwLevelTemp',
    circuitId,
    level,
    value: acceptedRange(setting, `${circuitId} ${level} temperature`, temp),
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
  // An unreadable charge (refused read) is not a read-only one: the PUT is still tried.
  if (charge === null) return { op: 'dhwCharge', circuitId, value: 'start' }
  return {
    op: 'dhwCharge',
    circuitId,
    value: acceptedOption(charge, `${circuitId} extra hot water`, 'start'),
  }
}

// ── climate presets: the gateway's away mode ────────────────────────────

export interface HomeComClimatePresets {
  readonly preset: string
  readonly availablePresets: readonly string[]
}

/** `none` / `away` while the gateway answers its away mode; no preset at all otherwise. */
export function climatePresetsFrom(away: HomeComHeatPumpSetting | null): HomeComClimatePresets {
  if (away === null) return { preset: '', availablePresets: [] }
  return { preset: away.value === 'on' ? 'away' : 'none', availablePresets: ['none', 'away'] }
}

export function awayPresetWrite(
  away: HomeComHeatPumpSetting | null,
  preset: string,
): HomeComBridgeWrite {
  if (preset !== 'away' && preset !== 'none') {
    throw new HomeComHeatPumpRefusalError(`HomeCom climate: preset "${preset}" is not offered`)
  }
  return {
    op: 'awayMode',
    value: acceptedOption(away, 'away mode', preset === 'away' ? 'on' : 'off'),
  }
}
