import type {
  HeatPumpCircuit,
  HeatPumpCircuitKind,
  HeatPumpOptionSetting,
  HeatPumpRangeSetting,
  HeatPumpStatus,
  HeatPumpSystem,
} from '@camstack/types'
import {
  readEnvelope,
  type PointtEnvelope,
  type PointtWrite,
  type ResourceGet,
} from './homecom-pointt.js'

/**
 * Heat-pump resources of a hydronic gateway (D1026).
 *
 * UNVERIFIED: the paths below come from the layout of the public HomeCom Easy
 * tree as the MIT `homecom_alt` library lists it, and were not checked against a
 * live heat pump. They live in this one table so a wrong path is a one-line
 * fix, and a resource the gateway does not answer reads as `null` (never 0),
 * which the hero then simply does not draw.
 */
export const HEAT_PUMP_PATHS = {
  system: {
    silent: '/heatSources/hs1/silentMode',
    away: '/system/awayMode',
    additionalHeater: '/heatSources/hs1/additionalHeaterMode',
    holiday: '/system/holidayMode',
  },
  readings: {
    thermalW: '/heatSources/hs1/heatPumpPower',
    electricalW: '/heatSources/hs1/electricalPower',
    compressorPct: '/heatSources/hs1/compressorModulation',
    supply: '/heatSources/hs1/supplyTemperature',
    return: '/heatSources/hs1/returnTemperature',
    outdoor: '/system/sensors/temperatures/outdoor_t1',
    thermalKwh: '/recordings/heatSources/total/thermalEnergy',
    electricalKwh: '/recordings/heatSources/total/electricalEnergy',
    pressureBar: '/heatSources/hs1/waterPressure',
    starts: '/heatSources/hs1/numberOfStarts',
  },
  circuit: {
    operationMode: 'operationMode',
    heatCoolMode: 'heatCoolMode',
    summerWinter: 'suWiSwitchMode',
    comfort: 'temperatureLevels/comfort2',
    eco: 'temperatureLevels/eco',
    maxFlow: 'maxSupplyTemperature',
    current: 'roomtemperature',
    target: 'currentRoomSetpoint',
  },
  dhw: {
    operationMode: 'operationMode',
    level: 'currentTemperatureLevel',
    chargeDuration: 'charge/duration',
    charge: 'charge',
    current: 'actualTemp',
    target: 'currentSetpoint',
  },
} as const

/** One setting as the gateway answered it, with the path a write goes to. */
export interface HomeComHeatPumpSetting {
  readonly path: string
  readonly value: string | number | boolean | null
  readonly min: number | null
  readonly max: number | null
  readonly allowed: readonly string[]
}

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
  readonly silent: HomeComHeatPumpSetting | null
  readonly away: HomeComHeatPumpSetting | null
  readonly additionalHeater: HomeComHeatPumpSetting | null
  readonly holiday: HomeComHeatPumpSetting | null
  readonly thermalW: number | null
  readonly electricalW: number | null
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

export interface HeatPumpReadInput {
  readonly get: ResourceGet
  /** Told once per failed read; the read itself carries on with `null` (never throws). */
  readonly onFailure?: (path: string, error: unknown) => void
  readonly circuitIds: { readonly hc: readonly string[]; readonly dhw: readonly string[] }
}

export async function readHeatPump(input: HeatPumpReadInput): Promise<HomeComHeatPumpReading> {
  const get = safeGet(input.get, input.onFailure)
  const circuits = await Promise.all([
    ...input.circuitIds.hc.map((id) => readHc(get, id)),
    ...input.circuitIds.dhw.map((id) => readDhwCircuit(get, id)),
  ])
  const r = HEAT_PUMP_PATHS.readings
  const s = HEAT_PUMP_PATHS.system
  const [silent, away, additionalHeater, holiday] = await Promise.all([
    setting(get, s.silent),
    setting(get, s.away),
    setting(get, s.additionalHeater),
    setting(get, s.holiday),
  ])
  const [thermalW, electricalW, compressorPct, supply, ret, outdoor] = await Promise.all([
    num(get, r.thermalW),
    num(get, r.electricalW),
    num(get, r.compressorPct),
    num(get, r.supply),
    num(get, r.return),
    num(get, r.outdoor),
  ])
  const [thermalKwh, electricalKwh, pressureBar, starts] = await Promise.all([
    num(get, r.thermalKwh),
    num(get, r.electricalKwh),
    num(get, r.pressureBar),
    num(get, r.starts),
  ])
  return {
    circuits,
    silent,
    away,
    additionalHeater,
    holiday,
    thermalW,
    electricalW,
    compressorPct,
    supply,
    return: ret,
    outdoor,
    thermalKwh,
    electricalKwh,
    pressureBar,
    starts,
  }
}

/** Any failure of a heat-pump read (HTTP 4xx/5xx, a throw) is "not answered", never an error. */
function safeGet(get: ResourceGet, onFailure: HeatPumpReadInput['onFailure']): ResourceGet {
  return async (path) => {
    try {
      return await get(path)
    } catch (error) {
      onFailure?.(path, error)
      return null
    }
  }
}

/**
 * True when a HEAT PUMP answered: silent mode, the auxiliary heater, heat-pump
 * power or compressor modulation. Flow temperatures, pressure and starts are left
 * out on purpose: a gas boiler's heat source answers those too, and it is no heat pump.
 */
export function hasHeatSource(reading: HomeComHeatPumpReading): boolean {
  return [
    reading.silent,
    reading.additionalHeater,
    reading.thermalW,
    reading.electricalW,
    reading.compressorPct,
  ].some((v) => v !== null)
}

async function readHc(get: ResourceGet, id: string): Promise<HomeComHeatPumpCircuitReading> {
  const base = `/heatingCircuits/${id}`
  const p = HEAT_PUMP_PATHS.circuit
  const [operationMode, heatCoolMode, summerWinter, comfort, eco, maxFlow, current, target] =
    await Promise.all([
      setting(get, `${base}/${p.operationMode}`),
      setting(get, `${base}/${p.heatCoolMode}`),
      setting(get, `${base}/${p.summerWinter}`),
      setting(get, `${base}/${p.comfort}`),
      setting(get, `${base}/${p.eco}`),
      setting(get, `${base}/${p.maxFlow}`),
      num(get, `${base}/${p.current}`),
      num(get, `${base}/${p.target}`),
    ])
  return {
    id,
    kind: 'hc',
    currentTemp: current,
    targetTemp: target,
    operationMode,
    heatCoolMode,
    summerWinter,
    comfort,
    eco,
    maxFlow,
    level: null,
    chargeDuration: null,
    charge: null,
  }
}

async function readDhwCircuit(
  get: ResourceGet,
  id: string,
): Promise<HomeComHeatPumpCircuitReading> {
  const base = `/dhwCircuits/${id}`
  const p = HEAT_PUMP_PATHS.dhw
  const [operationMode, level, chargeDuration, charge, current, target] = await Promise.all([
    setting(get, `${base}/${p.operationMode}`),
    setting(get, `${base}/${p.level}`),
    setting(get, `${base}/${p.chargeDuration}`),
    setting(get, `${base}/${p.charge}`),
    num(get, `${base}/${p.current}`),
    num(get, `${base}/${p.target}`),
  ])
  return {
    id,
    kind: 'dhw',
    currentTemp: current,
    targetTemp: target,
    operationMode,
    heatCoolMode: null,
    summerWinter: null,
    comfort: null,
    eco: null,
    maxFlow: null,
    level,
    chargeDuration,
    charge,
  }
}

async function setting(get: ResourceGet, path: string): Promise<HomeComHeatPumpSetting | null> {
  const envelope = readEnvelope(await get(path))
  return envelope === null ? null : settingOf(path, envelope)
}

async function num(get: ResourceGet, path: string): Promise<number | null> {
  const envelope = readEnvelope(await get(path))
  return envelope !== null && typeof envelope.value === 'number' && Number.isFinite(envelope.value)
    ? envelope.value
    : null
}

function settingOf(path: string, envelope: PointtEnvelope): HomeComHeatPumpSetting {
  return {
    path,
    value: envelope.value,
    min: envelope.min,
    max: envelope.max,
    allowed: envelope.allowed,
  }
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
    power: {
      thermalW: reading.thermalW,
      electricalW: reading.electricalW,
      compressorPct: reading.compressorPct,
    },
    temperatures: { supply: reading.supply, return: reading.return, outdoor: reading.outdoor },
    energy: { thermalKwh: reading.thermalKwh, electricalKwh: reading.electricalKwh },
    waterPressureBar: reading.pressureBar,
    starts: reading.starts,
    lastFetchedAt: now,
  }
}

function circuitOf(c: HomeComHeatPumpCircuitReading): HeatPumpCircuit {
  const kind = kindOf(c)
  const mode = textOf(c.operationMode)
  return {
    id: c.id,
    kind,
    label: labelOf(c),
    icon: kind === 'dhw' ? 'droplets' : kind === 'cooling' ? 'snowflake' : 'flame',
    currentTemp: c.currentTemp,
    targetTemp: c.targetTemp,
    mode,
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
  return textOf(c.heatCoolMode) === 'cooling' ? 'cooling' : 'heating'
}

function labelOf(c: HomeComHeatPumpCircuitReading): string {
  const n = c.id.replace(/^\D+/, '')
  if (c.kind === 'dhw') return n === '1' || n === '' ? 'Hot water' : `Hot water ${n}`
  return n === '' ? 'Circuit' : `Circuit ${n}`
}

function textOf(s: HomeComHeatPumpSetting | null): string | null {
  return s !== null && typeof s.value === 'string' && s.value.length > 0 ? s.value : null
}

function optionOf(s: HomeComHeatPumpSetting | null): HeatPumpOptionSetting | null {
  if (s === null) return null
  return { value: textOf(s), allowed: [...s.allowed] }
}

function rangeOf(s: HomeComHeatPumpSetting | null): HeatPumpRangeSetting | null {
  if (s === null) return null
  return {
    value: typeof s.value === 'number' && Number.isFinite(s.value) ? s.value : null,
    min: s.min,
    max: s.max,
    step: null,
  }
}

// ── writes ──────────────────────────────────────────────────────────────

function requireCircuit(reading: HomeComHeatPumpReading, circuitId: string, want: 'hc' | 'dhw') {
  const found = reading.circuits.find((c) => c.id === circuitId && c.kind === want)
  if (found === undefined) {
    throw new HomeComHeatPumpRefusalError(`HomeCom heat pump has no ${want} circuit ${circuitId}`)
  }
  return found
}

function optionWrite(s: HomeComHeatPumpSetting | null, what: string, mode: string): PointtWrite {
  if (s === null)
    throw new HomeComHeatPumpRefusalError(`HomeCom heat pump: ${what} is not available`)
  if (s.allowed.length === 0) {
    throw new HomeComHeatPumpRefusalError(`HomeCom heat pump: ${what} is read-only on this gateway`)
  }
  if (!s.allowed.includes(mode)) {
    throw new HomeComHeatPumpRefusalError(
      `HomeCom heat pump: "${mode}" is not an accepted value of ${what} (${s.allowed.join(', ')})`,
    )
  }
  return { path: s.path, value: mode }
}

function rangeWrite(s: HomeComHeatPumpSetting | null, what: string, value: number): PointtWrite {
  if (s === null)
    throw new HomeComHeatPumpRefusalError(`HomeCom heat pump: ${what} is not available`)
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
  return { path: s.path, value }
}

export function systemModeWrite(
  reading: HomeComHeatPumpReading,
  which: HeatPumpSystemMode,
  mode: string,
): PointtWrite {
  return optionWrite(reading[which], `${which} mode`, mode)
}

export function circuitOptionWrite(
  reading: HomeComHeatPumpReading,
  circuitId: string,
  which: HeatPumpCircuitOption,
  mode: string,
): PointtWrite {
  const circuit = requireCircuit(reading, circuitId, 'hc')
  return optionWrite(circuit[which], `${circuitId} ${which}`, mode)
}

export function dhwOptionWrite(
  reading: HomeComHeatPumpReading,
  circuitId: string,
  which: 'operationMode' | 'level',
  mode: string,
): PointtWrite {
  const circuit = requireCircuit(reading, circuitId, 'dhw')
  return optionWrite(circuit[which], `${circuitId} ${which}`, mode)
}

export function circuitRangeWrite(
  reading: HomeComHeatPumpReading,
  circuitId: string,
  which: 'comfort' | 'eco' | 'maxFlow',
  value: number,
): PointtWrite {
  return rangeWrite(requireCircuit(reading, circuitId, 'hc')[which], `${circuitId} ${which}`, value)
}

export function dhwChargeDurationWrite(
  reading: HomeComHeatPumpReading,
  circuitId: string,
  minutes: number,
): PointtWrite {
  return rangeWrite(
    requireCircuit(reading, circuitId, 'dhw').chargeDuration,
    `${circuitId} charge duration`,
    minutes,
  )
}

export function extraHotWaterWrite(
  reading: HomeComHeatPumpReading,
  circuitId: string,
): PointtWrite {
  const charge = requireCircuit(reading, circuitId, 'dhw').charge
  return optionWrite(charge, `${circuitId} extra hot water`, 'start')
}
