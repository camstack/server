import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * device-mesh — the radio / IP mesh a family of IoT devices lives on (a Matter
 * fabric over Thread or Wi-Fi today, a Zigbee network later).
 *
 * Not `mesh-network`: that one is the host VPN mesh (Tailscale). This one
 * describes how DEVICES reach each other and the hub — who routes for whom, how
 * strong each link is, what each node reports about itself.
 *
 * Device-native on purpose: a provider registers it on the devices it owns (a
 * Matter node container), so a per-device widget bound to the cap appears only
 * on devices that have a provider, and the framework derives the section from
 * the binding. Every method therefore names a `deviceId`: the topology call is
 * "the mesh this device sits in", and any device of the mesh answers it.
 *
 * Nothing is ever `0` for "could not read" (D393): a field the node did not
 * report, a cluster it does not carry and a read that failed are all `null`.
 * A battery-powered node is never read unasked — its figures come from what its
 * subscription already delivered, or from `readNow`.
 */

export const MeshTransportSchema = z.enum(['thread', 'wifi', 'ethernet', 'zigbee', 'unknown'])
export type MeshTransport = z.infer<typeof MeshTransportSchema>

export const MeshRoleSchema = z.enum([
  'border-router',
  'router',
  'end-device',
  'sleepy-end-device',
  'coordinator',
  'unknown',
])
export type MeshRole = z.infer<typeof MeshRoleSchema>

export const MeshPowerSchema = z.enum(['mains', 'battery', 'unknown'])
export type MeshPower = z.infer<typeof MeshPowerSchema>

export const MeshNodeSchema = z.object({
  /** The CamStack device of the node, `null` for a peer this provider did not commission. */
  deviceId: z.number().int().nonnegative().nullable(),
  /** Stable key within the provider; the endpoint of every link names one. */
  nodeKey: z.string().min(1),
  label: z.string(),
  transport: MeshTransportSchema,
  role: MeshRoleSchema,
  power: MeshPowerSchema,
  online: z.boolean(),
  /** Signal strength in dBm; `null` = unknown. */
  rssi: z.number().nullable(),
  /** Link quality 0..255 (Thread) or provider scale; `null` = unknown. */
  lqi: z.number().nullable(),
  /** Ms epoch of the last time something about this node was read; `null` = never. */
  lastReadAt: z.number().nullable(),
  /**
   * `MeshNetworkInfo.id` of the network this node sits in, when the provider knows
   * it per node (one answer may span several networks); absent / `null` = the
   * topology's own `network`.
   */
  networkId: z.string().nullable().optional(),
})
export type MeshNode = z.infer<typeof MeshNodeSchema>

export const MeshLinkKindSchema = z.enum(['neighbor', 'route'])

export const MeshLinkSchema = z.object({
  /** `nodeKey` of the node that reported the link. */
  from: z.string().min(1),
  /** `nodeKey` of the peer. */
  to: z.string().min(1),
  kind: MeshLinkKindSchema,
  lqi: z.number().nullable(),
  rssi: z.number().nullable(),
})
export type MeshLink = z.infer<typeof MeshLinkSchema>

/** What a provider really reports today (a Matter fabric spans these three). */
export const MeshTechnologySchema = z.enum(['thread', 'wifi', 'ethernet'])
export type MeshTechnology = z.infer<typeof MeshTechnologySchema>

/** The network a topology answer describes. Every field a provider did not read is `null`, never invented. */
export const MeshNetworkInfoSchema = z.object({
  /** Stable: the Thread extended PAN id (hex) when known, else a provider-scoped id. Two answers with one id are one network. */
  id: z.string().min(1),
  /** The network's own name (Thread `NetworkName`); `null` = not read. */
  name: z.string().nullable(),
  technology: MeshTechnologySchema,
  channel: z.number().int().nullable(),
  panId: z.number().int().nullable(),
})
export type MeshNetworkInfo = z.infer<typeof MeshNetworkInfoSchema>

export const MeshTopologySchema = z.object({
  /** The dominant network of these nodes (see each node's `networkId` for the others); `null` = a provider that does not say (or nothing read yet). */
  network: MeshNetworkInfoSchema.nullable(),
  /** Ms epoch of the newest read behind this answer; `null` = nothing read yet. */
  readAt: z.number().nullable(),
  nodes: z.array(MeshNodeSchema),
  links: z.array(MeshLinkSchema),
})
export type MeshTopology = z.infer<typeof MeshTopologySchema>

export const MeshFabricSchema = z.object({
  fabricIndex: z.number().int().nonnegative(),
  label: z.string().nullable(),
  vendorId: z.number().int().nonnegative().nullable(),
})
export type MeshFabric = z.infer<typeof MeshFabricSchema>

export const MeshThreadNeighborSchema = z.object({
  /** 16 hex digits. */
  extAddress: z.string(),
  rloc16: z.number().int().nullable(),
  lqi: z.number().nullable(),
  averageRssi: z.number().nullable(),
  lastRssi: z.number().nullable(),
  ageS: z.number().nullable(),
  isChild: z.boolean().nullable(),
  fullThreadDevice: z.boolean().nullable(),
})
export type MeshThreadNeighbor = z.infer<typeof MeshThreadNeighborSchema>

export const MeshThreadRouteSchema = z.object({
  extAddress: z.string(),
  rloc16: z.number().int().nullable(),
  routerId: z.number().int().nullable(),
  nextHop: z.number().int().nullable(),
  pathCost: z.number().nullable(),
  lqiIn: z.number().nullable(),
  lqiOut: z.number().nullable(),
  linkEstablished: z.boolean().nullable(),
})
export type MeshThreadRoute = z.infer<typeof MeshThreadRouteSchema>

export const MeshThreadDiagnosticsSchema = z.object({
  /** Raw Thread routing role name, e.g. `router`, `end-device`, `sleepy-end-device`, `leader`. */
  role: z.string().nullable(),
  /** Not a Thread diagnostics attribute: derived from the peers' tables; `null` = no peer lists this node. */
  rloc16: z.number().int().nullable(),
  channel: z.number().int().nullable(),
  panId: z.number().int().nullable(),
  extPanId: z.string().nullable(),
  partitionId: z.number().int().nullable(),
  neighbors: z.array(MeshThreadNeighborSchema).nullable(),
  routes: z.array(MeshThreadRouteSchema).nullable(),
})

export const MeshWifiDiagnosticsSchema = z.object({
  bssid: z.string().nullable(),
  rssi: z.number().nullable(),
  channel: z.number().int().nullable(),
  security: z.string().nullable(),
})

export const MeshEthernetDiagnosticsSchema = z.object({
  phyRateMbps: z.number().nullable(),
  fullDuplex: z.boolean().nullable(),
  carrierDetect: z.boolean().nullable(),
})

export const MeshNodeDiagnosticsSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  /** Ms epoch of the newest read behind this answer; `null` = never read. */
  readAt: z.number().nullable(),
  vendor: z.string().nullable(),
  product: z.string().nullable(),
  hardwareVersion: z.string().nullable(),
  softwareVersion: z.string().nullable(),
  uptimeS: z.number().nullable(),
  rebootCount: z.number().nullable(),
  bootReason: z.string().nullable(),
  /** Active network faults; `null` = not reported, `[]` = reported and none. */
  networkFaults: z.array(z.string()).nullable(),
  /** Fabrics the node is on (multi-admin); `null` = not reported. */
  fabrics: z.array(MeshFabricSchema).nullable(),
  thread: MeshThreadDiagnosticsSchema.nullable(),
  wifi: MeshWifiDiagnosticsSchema.nullable(),
  ethernet: MeshEthernetDiagnosticsSchema.nullable(),
})
export type MeshNodeDiagnostics = z.infer<typeof MeshNodeDiagnosticsSchema>

const DeviceInputSchema = z.object({
  deviceId: z.number().int().nonnegative(),
})

export const MeshReadNowResultSchema = z.object({
  /** False when the read failed; the diagnostics then carry what was known before. */
  readOk: z.boolean(),
  error: z.string().nullable(),
  diagnostics: MeshNodeDiagnosticsSchema,
})
export type MeshReadNowResult = z.infer<typeof MeshReadNowResultSchema>

export const MeshRefreshResultSchema = z.object({
  /** Mains-powered nodes read successfully. */
  readNodes: z.number().int().nonnegative(),
  /** Mains-powered nodes whose read failed. */
  failedNodes: z.number().int().nonnegative(),
  /** Nodes not read: battery-powered, power unknown, or offline. */
  skippedNodes: z.number().int().nonnegative(),
})
export type MeshRefreshResult = z.infer<typeof MeshRefreshResultSchema>

const NOT_EXPORTED = 'network diagnostics are an admin tool, not an ecosystem entity'

export const deviceMeshCapability = {
  name: 'device-mesh',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceConfig: {
    // The summary of where the device sits in its mesh, on its own device tab; the
    // widget reads through the cap and only its "Read now" button writes.
    ui: {
      kind: 'widget',
      widgetId: 'host/device-mesh',
      tab: 'network',
      topTab: true,
      label: 'Mesh network',
      order: 20,
    },
  },
  methods: {
    /** The mesh the device sits in: nodes and the links between them, from what is already held. */
    getTopology: method(DeviceInputSchema, MeshTopologySchema, {
      auth: 'admin',
      notOperatorFacing: NOT_EXPORTED,
    }),
    /** One node's own report: identity, uptime, faults, fabrics and its radio's figures. */
    getNodeDiagnostics: method(DeviceInputSchema, MeshNodeDiagnosticsSchema, {
      auth: 'admin',
      notOperatorFacing: NOT_EXPORTED,
    }),
    /** Read that one node now, battery nodes included (an explicit ask). */
    readNow: method(DeviceInputSchema, MeshReadNowResultSchema, {
      kind: 'mutation',
      auth: 'admin',
      notOperatorFacing: NOT_EXPORTED,
    }),
    /** Re-read the mains-powered nodes of the mesh; battery nodes are never touched. */
    refresh: method(DeviceInputSchema, MeshRefreshResultSchema, {
      kind: 'mutation',
      auth: 'admin',
      notOperatorFacing: NOT_EXPORTED,
    }),
  },
  vocabulary: { noun: t('Device mesh', 'Mesh dei dispositivi'), order: 3248 },
} as const satisfies CapabilityDefinition

export type IDeviceMeshProvider = InferProvider<typeof deviceMeshCapability>
