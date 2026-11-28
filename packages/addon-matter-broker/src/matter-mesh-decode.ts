/**
 * Pure decoder from a node's cached Matter attributes to the facts the
 * `device-mesh` capability reports. No matter.js import and no I/O: it reads
 * plain `{ endpointId, clusterId, attributeId, value, recordedAt }` records, the
 * shape the subscription cache and an explicit read both produce.
 *
 * Absent cluster, absent attribute and unreadable value are all `null` (D393),
 * never `0`; a list the node did not report is `null`, a reported empty list `[]`.
 */

import type {
  MeshFabric,
  MeshPower,
  MeshRole,
  MeshThreadNeighbor,
  MeshThreadRoute,
  MeshTransport,
} from '@dominevo/types'
import { decodePowerSourceKind, MatterAttributeId } from './matter-attr-decode.js'
import { MatterClusterId } from './matter-cluster-mapping.js'

/** One attribute value of a node, with the time it was recorded (ms epoch). */
export interface MeshAttr {
  readonly endpointId: number
  readonly clusterId: number
  readonly attributeId: number
  readonly value: unknown
  readonly recordedAt: number
}

/** Attribute ids per diagnostics cluster (Matter spec numbering). */
const BASIC = {
  vendorName: 1,
  productName: 3,
  hwString: 8,
  swString: 10,
  hwVersion: 7,
  swVersion: 9,
}
const GENERAL = {
  interfaces: 0,
  rebootCount: 1,
  upTime: 2,
  bootReason: 4,
  networkFaults: 7,
}
const THREAD = {
  channel: 0,
  routingRole: 1,
  networkName: 2,
  panId: 3,
  extPanId: 4,
  neighborTable: 7,
  routeTable: 8,
  partitionId: 9,
}
const WIFI = { bssid: 0, securityType: 1, channel: 3, rssi: 4 }
const ETHERNET = { phyRate: 0, fullDuplex: 1, carrierDetect: 7 }
const OPCRED = { fabrics: 1 }

const BOOT_REASONS: readonly string[] = [
  'unspecified',
  'power-on',
  'brown-out',
  'software-watchdog',
  'hardware-watchdog',
  'software-update-completed',
  'software-reset',
]
const NETWORK_FAULTS: readonly string[] = [
  'unspecified',
  'hardware-failure',
  'network-jammed',
  'connection-failed',
]
const WIFI_SECURITY: readonly string[] = ['unspecified', 'none', 'wep', 'wpa', 'wpa2', 'wpa3']
const THREAD_ROLES: readonly string[] = [
  'unspecified',
  'unassigned',
  'sleepy-end-device',
  'end-device',
  'reed',
  'router',
  'leader',
]
/** EthernetNetworkDiagnostics PHYRate enum → Mbps. */
const ETHERNET_RATES_MBPS: readonly number[] = [
  10, 100, 1000, 2500, 5000, 10000, 40000, 100000, 200000, 400000,
]
/** GeneralDiagnostics InterfaceTypeEnum. */
const INTERFACE_WIFI = 1
const INTERFACE_ETHERNET = 2
const INTERFACE_THREAD = 4

export interface ThreadFacts {
  readonly role: string | null
  readonly channel: number | null
  readonly panId: number | null
  readonly extPanId: string | null
  /** The Thread `NetworkName` attribute; `null` = not read. */
  readonly networkName: string | null
  readonly partitionId: number | null
  readonly neighbors: readonly MeshThreadNeighbor[] | null
  readonly routes: readonly MeshThreadRoute[] | null
  /** This node's own 64-bit address (GeneralDiagnostics Thread interface), 16 hex digits. */
  readonly ownExtAddress: string | null
}

export interface WifiFacts {
  readonly bssid: string | null
  readonly rssi: number | null
  readonly channel: number | null
  readonly security: string | null
}

export interface EthernetFacts {
  readonly phyRateMbps: number | null
  readonly fullDuplex: boolean | null
  readonly carrierDetect: boolean | null
}

/** Everything the cache says about one node. */
export interface NodeMeshFacts {
  readonly vendor: string | null
  readonly product: string | null
  readonly hardwareVersion: string | null
  readonly softwareVersion: string | null
  readonly uptimeS: number | null
  readonly rebootCount: number | null
  readonly bootReason: string | null
  readonly networkFaults: readonly string[] | null
  readonly fabrics: readonly MeshFabric[] | null
  readonly thread: ThreadFacts | null
  readonly wifi: WifiFacts | null
  readonly ethernet: EthernetFacts | null
  readonly transport: MeshTransport
  readonly role: MeshRole
  readonly power: MeshPower
  /** Newest `recordedAt` across the mesh clusters and PowerSource; `null` = none cached. */
  readonly readAt: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function asNum(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** 64-bit address as 16 lowercase hex digits (bigint, number, bytes or hex string). */
export function asExtAddress(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString(16).padStart(16, '0')
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.trunc(value).toString(16).padStart(16, '0')
  if (value instanceof Uint8Array) {
    return Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  if (typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value)) {
    return value.toLowerCase().padStart(16, '0')
  }
  return null
}

function nameOf(table: readonly string[], value: unknown): string | null {
  const n = asNum(value)
  return n === null ? null : (table[n] ?? null)
}

function list(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value
  return null
}

function field(entry: unknown, key: string): unknown {
  return isRecord(entry) ? entry[key] : undefined
}

function neighborOf(entry: unknown): MeshThreadNeighbor | null {
  const ext = asExtAddress(field(entry, 'extAddress'))
  if (ext === null) return null
  return {
    extAddress: ext,
    rloc16: asNum(field(entry, 'rloc16')),
    lqi: asNum(field(entry, 'lqi')),
    averageRssi: asNum(field(entry, 'averageRssi')),
    lastRssi: asNum(field(entry, 'lastRssi')),
    ageS: asNum(field(entry, 'age')),
    isChild: asBool(field(entry, 'isChild')),
    fullThreadDevice: asBool(field(entry, 'fullThreadDevice')),
  }
}

function routeOf(entry: unknown): MeshThreadRoute | null {
  const ext = asExtAddress(field(entry, 'extAddress'))
  if (ext === null) return null
  return {
    extAddress: ext,
    rloc16: asNum(field(entry, 'rloc16')),
    routerId: asNum(field(entry, 'routerId')),
    nextHop: asNum(field(entry, 'nextHop')),
    pathCost: asNum(field(entry, 'pathCost')),
    lqiIn: asNum(field(entry, 'lqiIn')),
    lqiOut: asNum(field(entry, 'lqiOut')),
    linkEstablished: asBool(field(entry, 'linkEstablished')),
  }
}

function mapList<T>(value: unknown, fn: (entry: unknown) => T | null): readonly T[] | null {
  const entries = list(value)
  if (entries === null) return null
  const out: T[] = []
  for (const entry of entries) {
    const item = fn(entry)
    if (item !== null) out.push(item)
  }
  return out
}

function fabricOf(entry: unknown): MeshFabric | null {
  const index = asNum(field(entry, 'fabricIndex'))
  if (index === null) return null
  return {
    fabricIndex: index,
    label: asStr(field(entry, 'label')),
    vendorId: asNum(field(entry, 'vendorId')),
  }
}

class AttrIndex {
  readonly #byKey = new Map<string, MeshAttr>()
  constructor(attrs: readonly MeshAttr[]) {
    for (const a of attrs) {
      const key = `${a.clusterId}:${a.attributeId}`
      const prev = this.#byKey.get(key)
      if (prev === undefined || a.recordedAt >= prev.recordedAt) this.#byKey.set(key, a)
    }
  }
  value(clusterId: number, attributeId: number): unknown {
    return this.#byKey.get(`${clusterId}:${attributeId}`)?.value
  }
  has(clusterId: number): boolean {
    for (const key of this.#byKey.keys()) if (key.startsWith(`${clusterId}:`)) return true
    return false
  }
}

function versionOf(index: AttrIndex, string: number, numeric: number): string | null {
  const text = asStr(index.value(MatterClusterId.BasicInformation, string))
  if (text !== null) return text
  const n = asNum(index.value(MatterClusterId.BasicInformation, numeric))
  return n === null ? null : String(n)
}

function interfaceAddress(index: AttrIndex, type: number): string | null {
  const interfaces = list(index.value(MatterClusterId.GeneralDiagnostics, GENERAL.interfaces))
  if (interfaces === null) return null
  for (const entry of interfaces) {
    if (asNum(field(entry, 'type')) === type) return asExtAddress(field(entry, 'hardwareAddress'))
  }
  return null
}

function threadOf(index: AttrIndex): ThreadFacts | null {
  const c = MatterClusterId.ThreadNetworkDiagnostics
  if (!index.has(c)) return null
  return {
    role: nameOf(THREAD_ROLES, index.value(c, THREAD.routingRole)),
    channel: asNum(index.value(c, THREAD.channel)),
    panId: asNum(index.value(c, THREAD.panId)),
    extPanId: asExtAddress(index.value(c, THREAD.extPanId)),
    networkName: asStr(index.value(c, THREAD.networkName)),
    partitionId: asNum(index.value(c, THREAD.partitionId)),
    neighbors: mapList(index.value(c, THREAD.neighborTable), neighborOf),
    routes: mapList(index.value(c, THREAD.routeTable), routeOf),
    ownExtAddress: interfaceAddress(index, INTERFACE_THREAD),
  }
}

function wifiOf(index: AttrIndex): WifiFacts | null {
  const c = MatterClusterId.WiFiNetworkDiagnostics
  if (!index.has(c)) return null
  const bssid = index.value(c, WIFI.bssid)
  return {
    bssid: bssid instanceof Uint8Array ? asExtAddress(bssid) : asStr(bssid),
    rssi: asNum(index.value(c, WIFI.rssi)),
    channel: asNum(index.value(c, WIFI.channel)),
    security: nameOf(WIFI_SECURITY, index.value(c, WIFI.securityType)),
  }
}

function ethernetOf(index: AttrIndex): EthernetFacts | null {
  const c = MatterClusterId.EthernetNetworkDiagnostics
  if (!index.has(c)) return null
  const rate = asNum(index.value(c, ETHERNET.phyRate))
  return {
    phyRateMbps: rate === null ? null : (ETHERNET_RATES_MBPS[rate] ?? null),
    fullDuplex: asBool(index.value(c, ETHERNET.fullDuplex)),
    carrierDetect: asBool(index.value(c, ETHERNET.carrierDetect)),
  }
}

function transportOf(index: AttrIndex, thread: ThreadFacts | null): MeshTransport {
  if (thread !== null) return 'thread'
  if (index.has(MatterClusterId.WiFiNetworkDiagnostics)) return 'wifi'
  if (index.has(MatterClusterId.EthernetNetworkDiagnostics)) return 'ethernet'
  const interfaces = list(index.value(MatterClusterId.GeneralDiagnostics, GENERAL.interfaces))
  const types = (interfaces ?? []).map((e) => asNum(field(e, 'type')))
  if (types.includes(INTERFACE_THREAD)) return 'thread'
  if (types.includes(INTERFACE_WIFI)) return 'wifi'
  if (types.includes(INTERFACE_ETHERNET)) return 'ethernet'
  return 'unknown'
}

function roleOf(thread: ThreadFacts | null): MeshRole {
  switch (thread?.role) {
    case 'sleepy-end-device':
      return 'sleepy-end-device'
    case 'end-device':
    case 'reed':
      return 'end-device'
    case 'router':
    case 'leader':
      return 'router'
    default:
      return 'unknown'
  }
}

/**
 * Mains or battery. The PowerSource cluster is the node's own statement (wired
 * wins over battery); without one, a Thread router or an Ethernet link means
 * mains and a sleepy end device means battery. Anything else is unknown.
 */
function powerOf(
  attrs: readonly MeshAttr[],
  index: AttrIndex,
  thread: ThreadFacts | null,
): MeshPower {
  const kinds = new Set<string>()
  let batteryAttribute = false
  for (const a of attrs) {
    if (a.clusterId !== MatterClusterId.PowerSource) continue
    if (a.attributeId === MatterAttributeId.FeatureMap) {
      const kind = decodePowerSourceKind(a.value)
      if (kind !== null) kinds.add(kind)
    } else if (
      a.attributeId === MatterAttributeId.BatPercentRemaining ||
      a.attributeId === MatterAttributeId.BatChargeLevel
    ) {
      batteryAttribute = true
    }
  }
  if (kinds.has('wired')) return 'mains'
  if (kinds.has('battery') || batteryAttribute) return 'battery'
  if (thread?.role === 'router' || thread?.role === 'leader') return 'mains'
  if (thread?.role === 'sleepy-end-device') return 'battery'
  if (index.has(MatterClusterId.EthernetNetworkDiagnostics)) return 'mains'
  return 'unknown'
}

const MESH_CLUSTERS: ReadonlySet<number> = new Set([
  MatterClusterId.BasicInformation,
  MatterClusterId.GeneralDiagnostics,
  MatterClusterId.ThreadNetworkDiagnostics,
  MatterClusterId.WiFiNetworkDiagnostics,
  MatterClusterId.EthernetNetworkDiagnostics,
  MatterClusterId.OperationalCredentials,
  MatterClusterId.PowerSource,
])

/** Decode every mesh-relevant fact of one node out of its cached attributes. */
export function decodeNodeMeshFacts(attrs: readonly MeshAttr[]): NodeMeshFacts {
  const index = new AttrIndex(attrs)
  const g = MatterClusterId.GeneralDiagnostics
  const thread = threadOf(index)
  const wifi = wifiOf(index)
  const newest = attrs.filter((a) => MESH_CLUSTERS.has(a.clusterId)).map((a) => a.recordedAt)
  return {
    vendor: asStr(index.value(MatterClusterId.BasicInformation, BASIC.vendorName)),
    product: asStr(index.value(MatterClusterId.BasicInformation, BASIC.productName)),
    hardwareVersion: versionOf(index, BASIC.hwString, BASIC.hwVersion),
    softwareVersion: versionOf(index, BASIC.swString, BASIC.swVersion),
    uptimeS: asNum(index.value(g, GENERAL.upTime)),
    rebootCount: asNum(index.value(g, GENERAL.rebootCount)),
    bootReason: nameOf(BOOT_REASONS, index.value(g, GENERAL.bootReason)),
    networkFaults: ((): readonly string[] | null => {
      const faults = list(index.value(g, GENERAL.networkFaults))
      if (faults === null) return null
      return faults.map((f) => nameOf(NETWORK_FAULTS, f)).filter((f): f is string => f !== null)
    })(),
    fabrics: mapList(index.value(MatterClusterId.OperationalCredentials, OPCRED.fabrics), fabricOf),
    thread,
    wifi,
    ethernet: ethernetOf(index),
    transport: transportOf(index, thread),
    role: roleOf(thread),
    power: powerOf(attrs, index, thread),
    readAt: newest.length === 0 ? null : Math.max(...newest),
  }
}
