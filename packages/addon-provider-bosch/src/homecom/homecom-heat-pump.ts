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
  /**
   * Resources only a heat pump's heat source has. A gateway that answers one of them with
   * anything but 404 (a 403 or a 500 included) has a heat pump it will not let us read.
   */
  identity: {
    heatPumpType: '/heatSources/hs1/heatPumpType',
    heatPumpPower: '/heatSources/hs1/heatPumpPower',
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
  /** The heat source answered a heat-pump-only resource with anything but 404, readable or not. */
  readonly heatSourceAnswered: boolean
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
  /** True when the path answered with any HTTP status but 404. Absent: no gateway evidence. */
  readonly answers?: (path: string) => Promise<boolean>
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
  const heatSourceAnswered = await anyAnswers(input.answers, input.onFailure, [
    HEAT_PUMP_PATHS.identity.heatPumpType,
    HEAT_PUMP_PATHS.identity.heatPumpPower,
  ])
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
    heatSourceAnswered,
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

async function anyAnswers(
  answers: HeatPumpReadInput['answers'],
  onFailure: HeatPumpReadInput['onFailure'],
  paths: readonly string[],
): Promise<boolean> {
  if (answers === undefined) return false
  const found = await Promise.all(
    paths.map(async (path) => {
      try {
        return await answers(path)
      } catch (error) {
        onFailure?.(path, error)
        return false
      }
    }),
  )
  return found.some(Boolean)
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

const SYSTEM_MODE_KEYS = ['silent', 'away', 'additionalHeater', 'holiday'] as const
const HEAT_PUMP_ONLY_READINGS = ['thermalW', 'electricalW', 'compressorPct'] as const

/**
 * True when the gateway should be offered as a system device (`hp:0`).
 *
 * A system mode counts when the gateway answered it: silent, away, the
 * additional heater, or holiday. An empty string is an answer (holiday often
 * comes back empty); a path that did not answer is not. A heat-pump-only
 * reading counts too (thermal power, electrical power, compressor modulation).
 * So does a circuit whose `heatCoolMode` can be cooling, and a heat source that
 * answers a heat-pump-only resource with any status but 404: some gateways
 * refuse (403) or fail (500) the whole system tree and still serve the
 * circuits. Supply, return, outdoor, pressure, starts and the energy meters do
 * not count: a gas boiler's heat source answers flow, pressure and starts, and
 * that is not a heat pump.
 */
export function hasSystemDevice(reading: HomeComHeatPumpReading): boolean {
  if (SYSTEM_MODE_KEYS.some((key) => reading[key] !== null)) return true
  if (HEAT_PUMP_ONLY_READINGS.some((key) => reading[key] !== null)) return true
  if (reading.heatSourceAnswered) return true
  return reading.circuits.some((c) => c.kind === 'hc' && offersCooling(c.heatCoolMode))
}

/**
 * A boiler circuit can carry a `heatCoolMode` that only ever says heating, so the mode alone
 * is no proof. A circuit that can switch to (or already is in) cooling is a heat pump's.
 */
function offersCooling(setting: HomeComHeatPumpSetting | null): boolean {
  if (setting === null) return false
  return setting.value === 'cooling' || setting.allowed.includes('cooling')
}

interface PathPresence {
  readonly path: string
  readonly present: boolean
}

export interface HeatPumpPathCensus {
  readonly answered: readonly string[]
  readonly unanswered: readonly string[]
}

/** Which heat-pump paths this gateway answered. One log per gateway corrects the path table. */
export function heatPumpPathCensus(reading: HomeComHeatPumpReading): HeatPumpPathCensus {
  const rows = [
    ...systemPathRows(reading),
    ...readingPathRows(reading),
    ...reading.circuits.flatMap(circuitPathRows),
  ]
  const answered: string[] = []
  const unanswered: string[] = []
  for (const row of rows) {
    if (row.present) answered.push(row.path)
    else unanswered.push(row.path)
  }
  return { answered, unanswered }
}

function systemPathRows(reading: HomeComHeatPumpReading): readonly PathPresence[] {
  const s = HEAT_PUMP_PATHS.system
  return [
    { path: s.silent, present: reading.silent !== null },
    { path: s.away, present: reading.away !== null },
    { path: s.additionalHeater, present: reading.additionalHeater !== null },
    { path: s.holiday, present: reading.holiday !== null },
  ]
}

function readingPathRows(reading: HomeComHeatPumpReading): readonly PathPresence[] {
  const r = HEAT_PUMP_PATHS.readings
  return [
    { path: r.thermalW, present: reading.thermalW !== null },
    { path: r.electricalW, present: reading.electricalW !== null },
    { path: r.compressorPct, present: reading.compressorPct !== null },
    { path: r.supply, present: reading.supply !== null },
    { path: r.return, present: reading.return !== null },
    { path: r.outdoor, present: reading.outdoor !== null },
    { path: r.thermalKwh, present: reading.thermalKwh !== null },
    { path: r.electricalKwh, present: reading.electricalKwh !== null },
    { path: r.pressureBar, present: reading.pressureBar !== null },
    { path: r.starts, present: reading.starts !== null },
  ]
}

function circuitPathRows(circuit: HomeComHeatPumpCircuitReading): readonly PathPresence[] {
  if (circuit.kind === 'dhw') return dhwPathRows(circuit)
  return hcPathRows(circuit)
}

function hcPathRows(circuit: HomeComHeatPumpCircuitReading): readonly PathPresence[] {
  const base = `/heatingCircuits/${circuit.id}`
  const p = HEAT_PUMP_PATHS.circuit
  return [
    { path: `${base}/${p.operationMode}`, present: circuit.operationMode !== null },
    { path: `${base}/${p.heatCoolMode}`, present: circuit.heatCoolMode !== null },
    { path: `${base}/${p.summerWinter}`, present: circuit.summerWinter !== null },
    { path: `${base}/${p.comfort}`, present: circuit.comfort !== null },
    { path: `${base}/${p.eco}`, present: circuit.eco !== null },
    { path: `${base}/${p.maxFlow}`, present: circuit.maxFlow !== null },
    { path: `${base}/${p.current}`, present: circuit.currentTemp !== null },
    { path: `${base}/${p.target}`, present: circuit.targetTemp !== null },
  ]
}

function dhwPathRows(circuit: HomeComHeatPumpCircuitReading): readonly PathPresence[] {
  const base = `/dhwCircuits/${circuit.id}`
  const p = HEAT_PUMP_PATHS.dhw
  return [
    { path: `${base}/${p.operationMode}`, present: circuit.operationMode !== null },
    { path: `${base}/${p.level}`, present: circuit.level !== null },
    { path: `${base}/${p.chargeDuration}`, present: circuit.chargeDuration !== null },
    { path: `${base}/${p.charge}`, present: circuit.charge !== null },
    { path: `${base}/${p.current}`, present: circuit.currentTemp !== null },
    { path: `${base}/${p.target}`, present: circuit.targetTemp !== null },
  ]
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
  return textOf(c.heatCoolMode) === 'cooling' ? 'cooling' : 'heating'
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
