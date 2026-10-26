import type { ClimateControlStatus, HvacMode, WaterHeaterStatus } from '@camstack/types'

export interface HomeComHeatingCircuit {
  readonly id: string
  readonly name: string
  readonly operationMode: string
  readonly setpoint: number | null
  readonly currentRoomTemp: number | null
  readonly minTemp: number | null
  readonly maxTemp: number | null
  readonly currentHumidity?: number | null
  /** `currentSuWiMode` when the circuit is not cooling; `cooling` when it is. */
  readonly season?: string | null
  readonly fanMode?: string
  readonly availableFanModes?: readonly string[]
  readonly swingVertical?: boolean | null
  readonly swingHorizontal?: boolean | null
  readonly availableModes?: readonly HvacMode[]
  /** Resource path the next setpoint write PUTs. */
  readonly setpointResource?: string
}

export interface HomeComDhw {
  readonly currentTemp: number | null
  readonly targetTemp: number | null
  readonly operationMode: string | null
  readonly availableModes: readonly string[]
  readonly minTemp: number | null
  readonly maxTemp: number | null
  readonly circuitId?: string
  /** Resource path the next target write PUTs. */
  readonly targetResource?: string
}

const MODE_MAP: Record<string, HvacMode> = {
  Off: 'off',
  off: 'off',
  Heat: 'heat',
  heat: 'heat',
  manual: 'heat',
  Cool: 'cool',
  cool: 'cool',
  Auto: 'auto',
  auto: 'auto',
  dry: 'dry',
  Dry: 'dry',
  fanOnly: 'fan_only',
  fan_only: 'fan_only',
}

function mapHvacMode(raw: string): HvacMode {
  return MODE_MAP[raw] ?? 'off'
}

/** PointT `allowedValues` mapped onto HVAC modes, in the order the device listed them. */
export function hvacModesFromAllowed(allowed: readonly string[]): readonly HvacMode[] {
  const out: HvacMode[] = []
  for (const raw of allowed) {
    const mapped = MODE_MAP[raw]
    if (mapped === undefined || out.includes(mapped)) continue
    out.push(mapped)
  }
  return out
}

function displayedMode(circuit: HomeComHeatingCircuit): HvacMode {
  const mapped = mapHvacMode(circuit.operationMode)
  if (mapped === 'off') return 'off'
  if (circuit.season === 'cooling') return 'cool'
  return mapped
}

export function climateSliceFromCircuit(
  circuit: HomeComHeatingCircuit,
  nowMs: number,
): ClimateControlStatus {
  const mode = displayedMode(circuit)
  const available = circuit.availableModes
  return {
    mode,
    availableModes:
      available !== undefined && available.length > 0 ? [...available] : ['off', 'heat', 'auto'],
    fanMode: circuit.fanMode ?? '',
    availableFanModes:
      circuit.availableFanModes !== undefined ? [...circuit.availableFanModes] : [],
    preset: '',
    availablePresets: [],
    target: circuit.setpoint,
    targetHigh: null,
    targetLow: null,
    targetHumidity: null,
    currentTemp: circuit.currentRoomTemp,
    currentHumidity: circuit.currentHumidity ?? null,
    swingVertical: circuit.swingVertical ?? null,
    swingHorizontal: circuit.swingHorizontal ?? null,
    minTemp: circuit.minTemp,
    maxTemp: circuit.maxTemp,
    tempStep: 0.5,
    lastFetchedAt: nowMs,
  }
}

export function waterHeaterSliceFromDhw(dhw: HomeComDhw, nowMs: number): WaterHeaterStatus {
  return {
    currentTemp: dhw.currentTemp,
    targetTemp: dhw.targetTemp,
    operationMode: dhw.operationMode,
    availableModes: [...dhw.availableModes],
    away: null,
    minTemp: dhw.minTemp,
    maxTemp: dhw.maxTemp,
    lastChangedAt: nowMs,
  }
}

/** Parse K40-style gateway JSON into heating circuits + DHW. Pure. */
export function parseHomeComSystemPayload(payload: unknown): {
  readonly circuits: readonly HomeComHeatingCircuit[]
  readonly dhw: HomeComDhw | null
} {
  if (typeof payload !== 'object' || payload === null) {
    return { circuits: [], dhw: null }
  }
  const root = payload as Record<string, unknown>
  const circuits: HomeComHeatingCircuit[] = []
  const rawCircuits = root['heatingCircuits']
  if (Array.isArray(rawCircuits)) {
    for (const item of rawCircuits) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      const id = row['id']
      if (typeof id !== 'string') continue
      circuits.push({
        id,
        name: typeof row['name'] === 'string' ? row['name'] : id,
        operationMode: typeof row['operationMode'] === 'string' ? row['operationMode'] : 'off',
        setpoint: readNum(row['setpoint']),
        currentRoomTemp: readNum(row['currentRoomTemperature']),
        minTemp: readNum(row['minTemp']),
        maxTemp: readNum(row['maxTemp']),
      })
    }
  }
  let dhw: HomeComDhw | null = null
  const rawDhw = root['domesticHotWater']
  if (typeof rawDhw === 'object' && rawDhw !== null) {
    const row = rawDhw as Record<string, unknown>
    const modes: string[] = []
    if (Array.isArray(row['operationModes'])) {
      for (const m of row['operationModes']) {
        if (typeof m === 'string') modes.push(m)
      }
    }
    dhw = {
      currentTemp: readNum(row['currentTemperature']),
      targetTemp: readNum(row['setpoint']),
      operationMode: typeof row['operationMode'] === 'string' ? row['operationMode'] : null,
      availableModes: modes.length > 0 ? modes : ['off', 'eco', 'performance'],
      minTemp: readNum(row['minTemp']),
      maxTemp: readNum(row['maxTemp']),
    }
  }
  return { circuits, dhw }
}

function readNum(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  return null
}
