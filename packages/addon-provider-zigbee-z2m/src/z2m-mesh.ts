/**
 * The Zigbee network as `device-mesh`. Held answers come from what the server already told us (the
 * device table, and the last network map); a scan is only ever started by an explicit `refresh` or
 * `readNow`. Zigbee2MQTT's own map scan queries the coordinator and the routers, never an end
 * device, so a battery node is never woken: its links are what its parent router reports.
 */
import type {
  IDeviceMeshProvider,
  MeshLink,
  MeshNetworkInfo,
  MeshNode,
  MeshNodeDiagnostics,
  MeshPower,
  MeshReadNowResult,
  MeshRefreshResult,
  MeshRole,
  MeshTopology,
} from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { Z2mBridgeInfo, Z2mDevice, Z2mNetworkMap } from './z2m-protocol.js'
import type { Z2mHub } from './z2m-hub.js'
import { Z2mNetworkMapSchema } from './z2m-protocol.js'

/** A full scan walks every router: it can take minutes on a large network. */
export const Z2M_MAP_SCAN_TIMEOUT_MS = 180_000

export interface HeldMap {
  readonly readAt: number
  readonly map: Z2mNetworkMap
}

export interface MeshInputs {
  readonly table: ReadonlyMap<string, Z2mDevice>
  readonly held: HeldMap | null
  readonly availability: (ieee: string) => boolean | null
  readonly deviceIdOf: (ieee: string) => number | null
  /** The bridge's own description (`bridge/info`); null until the server has sent it. */
  readonly bridge: Z2mBridgeInfo | null
}

function powerOf(device: Z2mDevice | undefined, type: string): MeshPower {
  const source = device?.power_source?.toLowerCase() ?? ''
  if (source.startsWith('battery')) return 'battery'
  if (source.includes('mains') || source.includes('dc source')) return 'mains'
  // A coordinator and a router are mains-fed by definition of the Zigbee roles.
  return type === 'Coordinator' || type === 'Router' ? 'mains' : 'unknown'
}

function roleOf(type: string, power: MeshPower): MeshRole {
  if (type === 'Coordinator') return 'coordinator'
  if (type === 'Router') return 'router'
  if (type === 'EndDevice') return power === 'battery' ? 'sleepy-end-device' : 'end-device'
  return 'unknown'
}

interface Endpoints {
  readonly from: string
  readonly to: string
}

function endpointsOf(link: Z2mNetworkMap['value']['links'][number]): Endpoints | null {
  const from = link.sourceIeeeAddr ?? link.source?.ieeeAddr
  const to = link.targetIeeeAddr ?? link.target?.ieeeAddr
  return from !== undefined && to !== undefined ? { from, to } : null
}

function hexOf(extendedPanId: string | readonly number[]): string {
  if (typeof extendedPanId === 'string') return extendedPanId.replace(/^0x/i, '').toLowerCase()
  return extendedPanId.map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The Zigbee network `bridge/info` describes; null when the server gave no extended PAN id to key it by. */
export function networkOf(bridge: Z2mBridgeInfo | null): MeshNetworkInfo | null {
  const net = bridge?.network
  if (net?.extended_pan_id === undefined) return null
  const id = hexOf(net.extended_pan_id)
  if (id === '') return null
  return {
    id,
    name: null,
    technology: 'zigbee',
    channel: net.channel ?? null,
    panId: net.pan_id ?? null,
  }
}

/** The topology the server told us about; links only once a map has been scanned. */
export function buildTopology(input: MeshInputs): MeshTopology {
  const mapNodes = new Map(input.held?.map.value.nodes.map((n) => [n.ieeeAddr, n]) ?? [])
  const links: MeshLink[] = []
  const quality = new Map<string, number>()
  for (const link of input.held?.map.value.links ?? []) {
    const ends = endpointsOf(link)
    if (ends === null) continue
    const lqi = link.linkquality ?? link.lqi ?? null
    links.push({
      from: ends.from,
      to: ends.to,
      kind: (link.routes?.length ?? 0) > 0 ? 'route' : 'neighbor',
      lqi,
      rssi: null,
    })
    if (lqi !== null) quality.set(ends.to, Math.max(quality.get(ends.to) ?? 0, lqi))
  }
  const nodes: MeshNode[] = []
  const seen = new Set<string>()
  const push = (ieee: string, device: Z2mDevice | undefined): void => {
    seen.add(ieee)
    const fromMap = mapNodes.get(ieee)
    const type = device?.type ?? fromMap?.type ?? 'unknown'
    const power = powerOf(device, type)
    nodes.push({
      deviceId: input.deviceIdOf(ieee),
      nodeKey: ieee,
      label: device?.friendly_name ?? fromMap?.friendlyName ?? ieee,
      transport: 'zigbee',
      role: roleOf(type, power),
      power,
      online: input.availability(ieee) !== false,
      rssi: null,
      lqi: quality.get(ieee) ?? null,
      lastReadAt: fromMap !== undefined ? (input.held?.readAt ?? null) : null,
    })
  }
  for (const [ieee, device] of input.table) push(ieee, device)
  for (const ieee of mapNodes.keys()) if (!seen.has(ieee)) push(ieee, undefined)
  return { network: networkOf(input.bridge), readAt: input.held?.readAt ?? null, nodes, links }
}

/** One node's own report; the radio figures a Zigbee node has no standard way to give stay `null`. */
export function buildDiagnostics(
  ieee: string,
  deviceId: number,
  input: MeshInputs,
): MeshNodeDiagnostics {
  const device = input.table.get(ieee)
  const failed = input.held?.map.value.nodes.find((n) => n.ieeeAddr === ieee)?.failed
  return {
    deviceId,
    readAt: input.held?.readAt ?? null,
    vendor: device?.definition?.vendor ?? device?.manufacturer ?? null,
    product: device?.definition?.model ?? device?.model_id ?? null,
    hardwareVersion: null,
    softwareVersion: device?.software_build_id ?? null,
    uptimeS: null,
    rebootCount: null,
    bootReason: null,
    networkFaults: failed ?? null,
    fabrics: null,
    thread: null,
    wifi: null,
    ethernet: null,
  }
}

/** What a scan counts: routers and the coordinator are read, end devices are never queried. */
export function scanCounts(map: Z2mNetworkMap): MeshRefreshResult {
  let read = 0
  let failed = 0
  let skipped = 0
  for (const node of map.value.nodes) {
    if (node.type === 'EndDevice') skipped += 1
    else if ((node.failed?.length ?? 0) > 0) failed += 1
    else read += 1
  }
  return { readNodes: read, failedNodes: failed, skippedNodes: skipped }
}

export function parseNetworkMap(data: unknown): Z2mNetworkMap | null {
  const parsed = Z2mNetworkMapSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** What the provider reaches the integration through. */
export interface MeshSource {
  inputs(): MeshInputs
  /** Run a scan now; resolves the parsed map, or throws with the reason. */
  scan(): Promise<HeldMap>
  ieeeOf(deviceId: number): string | null
}

export function buildMeshProvider(source: MeshSource): IDeviceMeshProvider {
  const diagnosticsOf = (deviceId: number): MeshNodeDiagnostics => {
    const ieee = source.ieeeOf(deviceId)
    if (ieee === null)
      throw new Error(`device ${deviceId} is not a Zigbee2MQTT node of this network`)
    return buildDiagnostics(ieee, deviceId, source.inputs())
  }
  return {
    getTopology: async () => buildTopology(source.inputs()),
    getNodeDiagnostics: async ({ deviceId }) => diagnosticsOf(deviceId),
    readNow: async ({ deviceId }): Promise<MeshReadNowResult> => {
      const before = diagnosticsOf(deviceId)
      try {
        await source.scan()
        return { readOk: true, error: null, diagnostics: diagnosticsOf(deviceId) }
      } catch (err: unknown) {
        return { readOk: false, error: errMsg(err), diagnostics: before }
      }
    },
    refresh: async (): Promise<MeshRefreshResult> => scanCounts((await source.scan()).map),
  }
}

/** Never two scans at once for one integration: a second caller joins the one in flight. */
const inFlight = new Map<string, Promise<HeldMap>>()

/** The provider of one integration, reading through the process-wide hub. */
export function meshProviderFor(
  hub: Z2mHub,
  integrationId: string,
  now: () => number = Date.now,
): IDeviceMeshProvider {
  const source: MeshSource = {
    inputs: () => {
      const session = hub.session(integrationId)
      return {
        table: session?.deviceTable() ?? new Map(),
        held: hub.heldMap(integrationId),
        availability: (ieee) => session?.availabilityOf(ieee) ?? null,
        deviceIdOf: (ieee) => hub.deviceIdOf(integrationId, ieee),
        bridge: session?.bridgeInfo ?? null,
      }
    },
    ieeeOf: (deviceId) => hub.ieeeOf(integrationId, deviceId),
    scan: () => {
      const running = inFlight.get(integrationId)
      if (running !== undefined) return running
      const session = hub.session(integrationId)
      if (session === null) return Promise.reject(new Error('the Zigbee2MQTT session is not open'))
      const scan = session
        .request(
          'bridge/request/networkmap',
          { type: 'raw', routes: false },
          Z2M_MAP_SCAN_TIMEOUT_MS,
        )
        .then((data) => {
          const map = parseNetworkMap(data)
          if (map === null)
            throw new Error('Zigbee2MQTT answered the network map in an unknown shape')
          const held: HeldMap = { readAt: now(), map }
          hub.holdMap(integrationId, held)
          return held
        })
        .finally(() => inFlight.delete(integrationId))
      inFlight.set(integrationId, scan)
      return scan
    },
  }
  return buildMeshProvider(source)
}
