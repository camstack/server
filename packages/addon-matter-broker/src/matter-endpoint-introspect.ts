/**
 * matter.js endpoint introspection helpers — the single, documented type
 * boundary where the addon reads the *dynamic* shape of a commissioned peer's
 * endpoints (cluster ids + attribute values) out of matter.js's runtime
 * behavior state.
 *
 * matter.js types a node's `state`/behaviors statically from the endpoint's
 * declared type. A commissioned `ClientNode`'s clusters are only known at
 * runtime, so we read them through the dynamic, string-keyed surface
 * (`endpoint.behaviors.supported`, `endpoint.stateOf(id)`) which is intrinsically
 * `Record<string, unknown>`-shaped. We narrow with `unknown` + type guards here —
 * NO `as any` — and keep ALL of that narrowing in this one module so the rest of
 * the controller works with plain `{ clusterId, attributeId, value }` data.
 *
 * Attribute IDs: matter.js exposes attribute *names* (camelCase) on the state
 * struct, not numeric ids. We map the names we care about back to the canonical
 * Matter attribute ids via {@link ATTR_NAME_TO_ID} so the decoder
 * (`matter-attr-decode.ts`) keys on stable numeric ids.
 */

import { MatterAttributeId } from './matter-attr-decode.js'

/** A matter.js Endpoint, viewed through the minimal dynamic surface we use. */
export interface MatterEndpointView {
  /** The endpoint number within the node (root = 0). */
  readonly number: number
  /** Server cluster ids present on this endpoint. */
  readonly clusterIds: readonly number[]
  /** One decoded attribute value per (cluster, attribute) we recognise. */
  readonly attributes: readonly MatterEndpointAttribute[]
}

/** A single attribute value read from an endpoint's behavior state. */
export interface MatterEndpointAttribute {
  readonly clusterId: number
  readonly attributeId: number
  readonly value: unknown
}

/**
 * Canonical Matter attribute name → numeric id for the attributes the decoder
 * understands. Only listed names are surfaced as reports; unknown attributes are
 * ignored (kept as latest-value cache only).
 */
const ATTR_NAME_TO_ID: ReadonlyMap<string, number> = new Map<string, number>([
  ['onOff', MatterAttributeId.OnOff],
  ['currentLevel', MatterAttributeId.CurrentLevel],
  ['stateValue', MatterAttributeId.StateValue],
  ['occupancy', MatterAttributeId.Occupancy],
  ['measuredValue', MatterAttributeId.MeasuredValue],
  ['batPercentRemaining', MatterAttributeId.BatPercentRemaining],
  ['batChargeState', MatterAttributeId.BatChargeState],
  ['localTemperature', MatterAttributeId.LocalTemperature],
  ['occupiedCoolingSetpoint', MatterAttributeId.OccupiedCoolingSetpoint],
  ['occupiedHeatingSetpoint', MatterAttributeId.OccupiedHeatingSetpoint],
  ['systemMode', MatterAttributeId.SystemMode],
  ['voltage', MatterAttributeId.Voltage],
  ['activeCurrent', MatterAttributeId.ActiveCurrent],
  ['activePower', MatterAttributeId.ActivePower],
  ['cumulativeEnergyImported', MatterAttributeId.CumulativeEnergyImported],
])

/** clusterId → matter.js behavior id (camelCase) for outbound command clusters. */
export const CLUSTER_ID_TO_BEHAVIOR_ID: ReadonlyMap<number, string> = new Map<number, string>([
  [0x0006, 'onOff'],
  [0x0008, 'levelControl'],
  [0x0300, 'colorControl'],
  [0x0101, 'doorLock'],
  [0x0201, 'thermostat'],
  [0x0102, 'windowCovering'],
])

/** A callable matter.js cluster command: `(input?, context?) => Promise`. */
type CommandFn = (input?: unknown) => Promise<unknown>

/** The minimal structural shape of a matter.js endpoint we read from. */
interface DynamicEndpoint {
  readonly number: number
  readonly behaviors: { readonly supported: unknown }
  readonly parts: Iterable<DynamicEndpoint>
  stateOf(id: string): unknown
  commandsOf(id: string): unknown
}

/** True when `value` is a non-null object (cast-free record narrowing). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read a finite numeric cluster id from a `Behavior.Type`'s `.cluster.id`. */
function clusterIdOf(behaviorType: unknown): number | null {
  if (!isRecord(behaviorType)) return null
  const cluster = behaviorType['cluster']
  if (!isRecord(cluster)) return null
  const id = cluster['id']
  if (typeof id === 'number' && Number.isFinite(id)) return id
  if (typeof id === 'bigint') return Number(id)
  return null
}

/**
 * Quack-test an arbitrary object for the dynamic endpoint surface we use. Keeps
 * the matter.js `Endpoint` interop at one typed boundary.
 */
function asDynamicEndpoint(value: unknown): DynamicEndpoint | null {
  if (!isRecord(value)) return null
  const number = value['number']
  const behaviors = value['behaviors']
  const parts = value['parts']
  const stateOf = value['stateOf']
  const commandsOf = value['commandsOf']
  if (
    typeof number === 'number' &&
    isRecord(behaviors) &&
    'supported' in behaviors &&
    typeof stateOf === 'function' &&
    typeof commandsOf === 'function' &&
    isIterable(parts)
  ) {
    return {
      number,
      behaviors: { supported: behaviors['supported'] },
      parts: mapIterable(parts, asDynamicEndpointOrThrow),
      stateOf: (id: string): unknown => stateOf.call(value, id),
      commandsOf: (id: string): unknown => commandsOf.call(value, id),
    }
  }
  return null
}

/**
 * Resolve + invoke an outbound cluster command on a node's endpoint. Walks the
 * node's endpoints for the matching endpoint number, maps the cluster id to its
 * behavior id, and calls the named command with `args`. Throws a clear error
 * when the endpoint / cluster / command is unavailable.
 */
export async function invokeNodeCommand(input: {
  readonly rootEndpoint: unknown
  readonly endpointId: number
  readonly clusterId: number
  readonly commandName: string
  readonly args?: Record<string, unknown>
}): Promise<void> {
  const { rootEndpoint, endpointId, clusterId, commandName, args } = input
  const root = asDynamicEndpoint(rootEndpoint)
  if (root === null) throw new Error('matter-broker: node has no readable endpoints')

  const target = findEndpoint(root, endpointId)
  if (target === null) throw new Error(`matter-broker: endpoint ${endpointId} not found on node`)

  const behaviorId = CLUSTER_ID_TO_BEHAVIOR_ID.get(clusterId)
  if (behaviorId === undefined) {
    throw new Error(`matter-broker: cluster 0x${clusterId.toString(16)} has no command binding`)
  }

  const commands = target.commandsOf(behaviorId)
  if (!isRecord(commands)) {
    throw new Error(`matter-broker: endpoint ${endpointId} has no '${behaviorId}' commands`)
  }
  const command = commands[commandName]
  const fn = asCommandFn(command)
  if (fn === null) {
    throw new Error(`matter-broker: command '${commandName}' unavailable on '${behaviorId}'`)
  }
  await fn(args ?? {})
}

/** Narrow an unknown matter.js command entry to a callable, cast-free. */
function asCommandFn(value: unknown): CommandFn | null {
  if (typeof value !== 'function') return null
  const fn: CommandFn = (input) => Promise.resolve(Reflect.apply(value, undefined, [input]))
  return fn
}

function findEndpoint(endpoint: DynamicEndpoint, number: number): DynamicEndpoint | null {
  if (endpoint.number === number) return endpoint
  for (const part of endpoint.parts) {
    const found = findEndpoint(part, number)
    if (found !== null) return found
  }
  return null
}

function asDynamicEndpointOrThrow(value: unknown): DynamicEndpoint {
  const ep = asDynamicEndpoint(value)
  if (ep === null) throw new TypeError('matter-broker: unexpected non-endpoint child part')
  return ep
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return isRecord(value) && typeof Reflect.get(value, Symbol.iterator) === 'function'
}

function* mapIterable<T>(it: Iterable<unknown>, fn: (v: unknown) => T): Generator<T> {
  for (const v of it) yield fn(v)
}

/**
 * Walk a commissioned node's root endpoint + all descendant parts, reading each
 * endpoint's supported clusters and the recognised attribute values out of its
 * behavior state. Pure read — no mutation of matter.js state.
 */
export function readNodeEndpoints(rootEndpoint: unknown): MatterEndpointView[] {
  const root = asDynamicEndpoint(rootEndpoint)
  if (root === null) return []
  const out: MatterEndpointView[] = []
  collectEndpoint(root, out)
  return out
}

function collectEndpoint(endpoint: DynamicEndpoint, out: MatterEndpointView[]): void {
  const supported = endpoint.behaviors.supported
  const clusterIds: number[] = []
  const attributes: MatterEndpointAttribute[] = []

  if (isRecord(supported)) {
    for (const [behaviorId, behaviorType] of Object.entries(supported)) {
      const clusterId = clusterIdOf(behaviorType)
      if (clusterId === null) continue
      clusterIds.push(clusterId)
      readBehaviorAttributes(endpoint, behaviorId, clusterId, attributes)
    }
  }

  out.push({ number: endpoint.number, clusterIds, attributes })
  for (const part of endpoint.parts) collectEndpoint(part, out)
}

function readBehaviorAttributes(
  endpoint: DynamicEndpoint,
  behaviorId: string,
  clusterId: number,
  attributes: MatterEndpointAttribute[],
): void {
  let struct: unknown
  try {
    struct = endpoint.stateOf(behaviorId)
  } catch {
    // Some behaviors carry no readable state for a client node — skip.
    return
  }
  if (!isRecord(struct)) return
  for (const [attrName, value] of Object.entries(struct)) {
    const attributeId = ATTR_NAME_TO_ID.get(attrName)
    if (attributeId === undefined) continue
    attributes.push({ clusterId, attributeId, value })
  }
}
