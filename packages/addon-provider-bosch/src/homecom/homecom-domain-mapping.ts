import type { ClimateControlStatus, HvacMode, WaterHeaterStatus } from '@camstack/types'

export interface HomeComHeatingCircuit {
  readonly id: string
  readonly name: string
  readonly operationMode: string
  readonly setpoint: number | null
  readonly currentRoomTemp: number | null
  readonly minTemp: number | null
  readonly maxTemp: number | null
}

export interface HomeComDhw {
  readonly currentTemp: number | null
  readonly targetTemp: number | null
  readonly operationMode: string | null
  readonly availableModes: readonly string[]
  readonly minTemp: number | null
  readonly maxTemp: number | null
}

const MODE_MAP: Record<string, HvacMode> = {
  Off: 'off',
  off: 'off',
  Heat: 'heat',
  heat: 'heat',
  Cool: 'cool',
  cool: 'cool',
  Auto: 'auto',
  auto: 'auto',
}

function mapHvacMode(raw: string): HvacMode {
  return MODE_MAP[raw] ?? 'off'
}

export function climateSliceFromCircuit(
  circuit: HomeComHeatingCircuit,
  nowMs: number,
): ClimateControlStatus {
  const mode = mapHvacMode(circuit.operationMode)
  return {
    mode,
    availableModes: ['off', 'heat', 'auto'],
    fanMode: '',
    availableFanModes: [],
    preset: '',
    availablePresets: [],
    target: circuit.setpoint,
    targetHigh: null,
    targetLow: null,
    targetHumidity: null,
    currentTemp: circuit.currentRoomTemp,
    currentHumidity: null,
    swingVertical: null,
    swingHorizontal: null,
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
