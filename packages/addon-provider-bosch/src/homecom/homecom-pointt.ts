import type { HvacMode } from '@camstack/types'
import type { HomeComResourceFamily } from './homecom-device-type.js'
import { hvacModesFromAllowed } from './homecom-domain-mapping.js'
import type { HomeComDhw, HomeComHeatingCircuit } from './homecom-domain-mapping.js'
import type { HomeComGatewayInfo, HomeComSystemSnapshot } from './homecom-api-client.js'

/**
 * PointT resource reads and writes.
 *
 * Paths are the public HomeCom Easy resources (`/heatingCircuits/hc1/…`,
 * `/dhwCircuits/dhw1/…`, `/airConditioning/…`, `/gateway/DateTime`). The MIT
 * `homecom_alt` library is the record of which path each device type answers;
 * this module is not a copy of that code. A resource this addon has no cap for
 * is not requested — the caller logs that drop.
 */

export const HOMECOM_RAC_CIRCUIT_ID = 'ac'
export const HOMECOM_PROBE_CLOCK = '/gateway/DateTime'
export const HOMECOM_PROBE_FIRMWARE = '/gateway/versionFirmware'

const HYDRONIC_DROPPED =
  'heat-source, ventilation, pool and energy resources are not published on a cap'
const RAC_DROPPED =
  'domestic hot water, presets and a humidity target are not published for an air conditioner'
const WATER_HEATER_DROPPED = 'heating circuits are not on a wddw2 water heater'
const ZONE_DROPPED = 'rrc2 zones are not published on a cap'
const UNSUPPORTED_CONTROLS =
  'fan mode, swing, presets and a humidity target are not on this device type'

const HYDRONIC_MODES: readonly HvacMode[] = ['off', 'heat', 'auto']
const TOKEN = /^[A-Za-z0-9_-]+$/

export type ResourceGet = (path: string) => Promise<unknown | null>

export interface PointtEnvelope {
  readonly value: string | number | boolean
  readonly min: number | null
  readonly max: number | null
  readonly allowed: readonly string[]
}

export interface PointtWrite {
  readonly path: string
  readonly value: string | number | boolean
}

export interface PointtReadInput {
  readonly deviceType: string
  readonly family: HomeComResourceFamily
  readonly gatewayId: string
  readonly get: ResourceGet
  readonly logDrop: (reason: string) => void
}

export function readEnvelope(body: unknown): PointtEnvelope | null {
  if (!isRecord(body) || !('value' in body)) return null
  const value = body['value']
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null
  }
  return {
    value,
    min: finite(body['minValue']),
    max: finite(body['maxValue']),
    allowed: stringList(body['allowedValues']),
  }
}

export function probeText(body: unknown): string | null {
  const envelope = readEnvelope(body)
  if (envelope === null) return null
  if (typeof envelope.value === 'string' && envelope.value.length > 0) return envelope.value
  if (typeof envelope.value === 'number' || typeof envelope.value === 'boolean') {
    return String(envelope.value)
  }
  return null
}

export async function readPointtSnapshot(input: PointtReadInput): Promise<HomeComSystemSnapshot> {
  if (input.family === 'rac') return readRac(input)
  if (input.family === 'water-heater') return readWaterHeater(input)
  return readHydronic(input)
}

export function circuitSetpointWrite(
  snapshot: HomeComSystemSnapshot,
  circuitId: string,
  temp: number,
): PointtWrite {
  const circuit = findCircuit(snapshot, circuitId)
  const path = circuit.setpointResource ?? `/heatingCircuits/${circuitId}/manualRoomSetpoint`
  return { path, value: temp }
}

export function circuitModeWrites(
  snapshot: HomeComSystemSnapshot,
  circuitId: string,
  mode: string,
): readonly PointtWrite[] {
  const token = pointtMode(mode)
  if (snapshot.family === 'rac') {
    if (token === 'off') return [{ path: '/airConditioning/acControl', value: 'off' }]
    return [
      { path: '/airConditioning/acControl', value: 'on' },
      { path: '/airConditioning/operationMode', value: token },
    ]
  }
  if (token === 'cool') {
    return [{ path: `/heatingCircuits/${circuitId}/heatCoolMode`, value: 'cooling' }]
  }
  return [{ path: `/heatingCircuits/${circuitId}/operationMode`, value: token }]
}

export function dhwTargetWrite(snapshot: HomeComSystemSnapshot, temp: number): PointtWrite {
  const dhw = snapshot.dhw
  if (dhw?.targetResource === undefined) {
    throw new Error('HomeCom DHW: setpoint not supported')
  }
  return { path: dhw.targetResource, value: temp }
}

export function dhwModeWrite(snapshot: HomeComSystemSnapshot, mode: string): PointtWrite {
  const id = snapshot.dhw?.circuitId
  if (id === undefined) throw new Error('HomeCom DHW: setpoint not supported')
  return { path: `/dhwCircuits/${id}/operationMode`, value: mode }
}

export function fanWrite(snapshot: HomeComSystemSnapshot, fanMode: string): PointtWrite {
  if (snapshot.family !== 'rac') throw new Error('HomeCom climate: fan mode not supported')
  return { path: '/airConditioning/fanSpeed', value: fanMode }
}

export function swingWrite(
  snapshot: HomeComSystemSnapshot,
  axis: 'vertical' | 'horizontal',
  on: boolean,
): PointtWrite {
  if (snapshot.family !== 'rac') throw new Error('HomeCom climate: swing not supported')
  if (axis === 'vertical') {
    return { path: '/airConditioning/airFlowVertical', value: on ? 'swing' : 'angle3' }
  }
  return { path: '/airConditioning/airFlowHorizontal', value: on ? 'swing' : 'center' }
}

async function readHydronic(input: PointtReadInput): Promise<HomeComSystemSnapshot> {
  input.logDrop(HYDRONIC_DROPPED)
  input.logDrop(UNSUPPORTED_CONTROLS)
  if (input.deviceType === 'rrc2') input.logDrop(ZONE_DROPPED)
  const heating = await input.get('/heatingCircuits')
  const dhwBody = await input.get('/dhwCircuits')
  const circuits: HomeComHeatingCircuit[] = []
  for (const id of referenceKeys(heating, 'hc')) {
    circuits.push(await readCircuit(input.get, id))
  }
  const dhwIds = referenceKeys(dhwBody, 'dhw')
  const first = dhwIds[0]
  const dhw = first === undefined ? null : await readDhw(input.get, first)
  if (dhwIds.length > 1) {
    input.logDrop(`extra DHW circuits are not published: ${dhwIds.slice(1).join(', ')}`)
  }
  return snapshotOf(input, circuits, dhw)
}

async function readWaterHeater(input: PointtReadInput): Promise<HomeComSystemSnapshot> {
  input.logDrop(WATER_HEATER_DROPPED)
  const dhwBody = await input.get('/dhwCircuits')
  const first = referenceKeys(dhwBody, 'dhw')[0]
  const dhw = first === undefined ? null : await readDhw(input.get, first)
  if (dhw === null) input.logDrop('this water heater returned no DHW circuit')
  return snapshotOf(input, [], dhw)
}

async function readRac(input: PointtReadInput): Promise<HomeComSystemSnapshot> {
  input.logDrop(RAC_DROPPED)
  const names = [
    'operationMode',
    'temperatureSetpoint',
    'acControl',
    'fanSpeed',
    'airFlowVertical',
    'airFlowHorizontal',
    'roomTemperature',
  ] as const
  const inline = indexStandard(await input.get('/airConditioning/standardFunctions'))
  const loaded = new Map<string, PointtEnvelope | null>()
  for (const name of names) {
    const direct = readEnvelope(await input.get(`/airConditioning/${name}`))
    loaded.set(name, direct ?? inline.get(name) ?? null)
  }
  const power = stringOf(loaded.get('acControl') ?? null)
  const operation = loaded.get('operationMode') ?? null
  const setpoint = loaded.get('temperatureSetpoint') ?? null
  const fan = loaded.get('fanSpeed') ?? null
  const modes = hvacModesFromAllowed(operation?.allowed ?? [])
  const availableModes = modes.includes('off') ? modes : [...modes, 'off' as const]
  const circuit: HomeComHeatingCircuit = {
    id: HOMECOM_RAC_CIRCUIT_ID,
    name: 'Air conditioning',
    operationMode: power === 'off' ? 'off' : (stringOf(operation) ?? 'off'),
    setpoint: numberOf(setpoint),
    currentRoomTemp: numberOf(loaded.get('roomTemperature') ?? null),
    minTemp: setpoint?.min ?? null,
    maxTemp: setpoint?.max ?? null,
    currentHumidity: null,
    season: null,
    fanMode: stringOf(fan) ?? '',
    availableFanModes: fan?.allowed ?? [],
    swingVertical: swingOf(loaded.get('airFlowVertical') ?? null),
    swingHorizontal: swingOf(loaded.get('airFlowHorizontal') ?? null),
    availableModes: availableModes.length > 0 ? availableModes : ['off', 'cool', 'heat', 'auto'],
    setpointResource: '/airConditioning/temperatureSetpoint',
  }
  return snapshotOf(input, [circuit], null)
}

async function readCircuit(get: ResourceGet, id: string): Promise<HomeComHeatingCircuit> {
  const base = `/heatingCircuits/${id}`
  const loaded = await loadEnvelopes(get, [
    `${base}/operationMode`,
    `${base}/roomtemperature`,
    `${base}/manualRoomSetpoint`,
    `${base}/currentRoomSetpoint`,
    `${base}/currentSuWiMode`,
    `${base}/heatCoolMode`,
    `${base}/actualHumidity`,
    `${base}/cooling/roomTempSetpoint`,
  ])
  const operation = loaded.get(`${base}/operationMode`) ?? null
  const manual = loaded.get(`${base}/manualRoomSetpoint`) ?? null
  const current = loaded.get(`${base}/currentRoomSetpoint`) ?? null
  const coolingSet = loaded.get(`${base}/cooling/roomTempSetpoint`) ?? null
  const season = stringOf(loaded.get(`${base}/currentSuWiMode`) ?? null)
  const heatCool = stringOf(loaded.get(`${base}/heatCoolMode`) ?? null)
  const cooling = season === 'cooling' || heatCool === 'cooling'
  const modes = hvacModesFromAllowed(operation?.allowed ?? [])
  const humidity = numberOf(loaded.get(`${base}/actualHumidity`) ?? null)
  return {
    id,
    name: id,
    operationMode: stringOf(operation) ?? 'off',
    setpoint: cooling
      ? (numberOf(coolingSet) ?? numberOf(current) ?? numberOf(manual))
      : (numberOf(current) ?? numberOf(manual)),
    currentRoomTemp: numberOf(loaded.get(`${base}/roomtemperature`) ?? null),
    minTemp: manual?.min ?? current?.min ?? null,
    maxTemp: manual?.max ?? current?.max ?? null,
    currentHumidity: humidity !== null && humidity >= 0 && humidity <= 100 ? humidity : null,
    season: cooling ? 'cooling' : season,
    fanMode: '',
    availableFanModes: [],
    swingVertical: null,
    swingHorizontal: null,
    availableModes: modes.length > 0 ? modes : [...HYDRONIC_MODES],
    setpointResource: cooling ? `${base}/cooling/roomTempSetpoint` : `${base}/manualRoomSetpoint`,
  }
}

async function readDhw(get: ResourceGet, id: string): Promise<HomeComDhw> {
  const base = `/dhwCircuits/${id}`
  const loaded = await loadEnvelopes(get, [
    `${base}/operationMode`,
    `${base}/actualTemp`,
    `${base}/outletTemperature`,
    `${base}/currentTemperatureLevel`,
    `${base}/currentSetpoint`,
    `${base}/manualsetpoint`,
  ])
  const operation = loaded.get(`${base}/operationMode`) ?? null
  const level = safeToken(stringOf(loaded.get(`${base}/currentTemperatureLevel`) ?? null))
  const chosen = await chooseDhwTarget(get, base, loaded, level)
  const modes = operation?.allowed ?? []
  return {
    currentTemp:
      numberOf(loaded.get(`${base}/actualTemp`) ?? null) ??
      numberOf(loaded.get(`${base}/outletTemperature`) ?? null),
    targetTemp: chosen.target,
    operationMode: stringOf(operation),
    availableModes: modes.length > 0 ? [...modes] : ['off', 'eco', 'performance'],
    minTemp: chosen.min,
    maxTemp: chosen.max,
    circuitId: id,
    targetResource: chosen.resource,
  }
}

async function chooseDhwTarget(
  get: ResourceGet,
  base: string,
  loaded: ReadonlyMap<string, PointtEnvelope | null>,
  level: string | null,
): Promise<{ target: number | null; min: number | null; max: number | null; resource: string }> {
  const current = loaded.get(`${base}/currentSetpoint`) ?? null
  if (numberOf(current) !== null) {
    return bound(current, numberOf(current), `${base}/currentSetpoint`)
  }
  if (level !== null && level !== 'off') {
    const levelEnv = readEnvelope(await get(`${base}/temperatureLevels/${level}`))
    if (numberOf(levelEnv) !== null) {
      return bound(levelEnv, numberOf(levelEnv), `${base}/temperatureLevels/${level}`)
    }
  }
  const manual = loaded.get(`${base}/manualsetpoint`) ?? null
  return bound(manual, numberOf(manual), `${base}/manualsetpoint`)
}

function bound(
  envelope: PointtEnvelope | null,
  target: number | null,
  resource: string,
): { target: number | null; min: number | null; max: number | null; resource: string } {
  return { target, min: envelope?.min ?? null, max: envelope?.max ?? null, resource }
}

async function loadEnvelopes(
  get: ResourceGet,
  paths: readonly string[],
): Promise<ReadonlyMap<string, PointtEnvelope | null>> {
  const pairs = await Promise.all(
    paths.map(async (path) => [path, readEnvelope(await get(path))] as const),
  )
  return new Map(pairs)
}

function snapshotOf(
  input: PointtReadInput,
  circuits: readonly HomeComHeatingCircuit[],
  dhw: HomeComDhw | null,
): HomeComSystemSnapshot {
  const gateway: HomeComGatewayInfo = {
    gatewayId: input.gatewayId,
    name: input.gatewayId,
    model: input.deviceType,
  }
  return {
    gateway,
    circuits,
    dhw,
    deviceType: input.deviceType,
    family: input.family,
  }
}

function findCircuit(snapshot: HomeComSystemSnapshot, circuitId: string): HomeComHeatingCircuit {
  const circuit = snapshot.circuits.find((item) => item.id === circuitId)
  if (circuit === undefined) throw new Error(`HomeCom has no heating circuit ${circuitId}`)
  return circuit
}

function pointtMode(mode: string): string {
  switch (mode) {
    case 'Heat':
    case 'heat':
    case 'manual':
      return 'manual'
    case 'Auto':
    case 'auto':
      return 'auto'
    case 'Cool':
    case 'cool':
      return 'cool'
    case 'Dry':
    case 'dry':
      return 'dry'
    case 'fan_only':
    case 'fanOnly':
      return 'fanOnly'
    case 'Off':
    case 'off':
      return 'off'
    default:
      return mode
  }
}

function referenceKeys(body: unknown, prefix: string): readonly string[] {
  if (!isRecord(body) || !Array.isArray(body['references'])) return []
  const pattern = prefix === 'hc' ? /^hc\d+$/ : /^dhw\d+$/
  const out: string[] = []
  for (const ref of body['references']) {
    if (!isRecord(ref) || typeof ref['id'] !== 'string') continue
    const tail = ref['id']
      .split('/')
      .filter((part) => part.length > 0)
      .at(-1)
    if (tail === undefined || !pattern.test(tail) || out.includes(tail)) continue
    out.push(tail)
  }
  return out
}

function indexStandard(body: unknown): ReadonlyMap<string, PointtEnvelope> {
  const map = new Map<string, PointtEnvelope>()
  if (!isRecord(body) || !Array.isArray(body['references'])) return map
  for (const ref of body['references']) {
    if (!isRecord(ref) || typeof ref['id'] !== 'string') continue
    const tail =
      ref['id']
        .split('/')
        .filter((part) => part.length > 0)
        .at(-1) ?? ref['id']
    const envelope = readEnvelope(ref)
    if (envelope !== null) map.set(tail, envelope)
  }
  return map
}

function numberOf(envelope: PointtEnvelope | null): number | null {
  if (envelope === null) return null
  return typeof envelope.value === 'number' && Number.isFinite(envelope.value)
    ? envelope.value
    : null
}

function stringOf(envelope: PointtEnvelope | null): string | null {
  if (envelope === null || typeof envelope.value !== 'string' || envelope.value.length === 0) {
    return null
  }
  return envelope.value
}

function swingOf(envelope: PointtEnvelope | null): boolean | null {
  const value = stringOf(envelope)
  if (value === null) return null
  return value === 'swing'
}

function safeToken(value: string | null): string | null {
  if (value === null || !TOKEN.test(value)) return null
  return value
}

function finite(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

function stringList(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string') out.push(item)
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
