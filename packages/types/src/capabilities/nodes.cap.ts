import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * nodes — system-scoped singleton capability for cluster topology
 * queries and remote addon lifecycle operations.
 *
 * Implementation lives in the server's `AgentRegistryService`,
 * `MoleculerService`, and `AddonRegistryService`. The provider is
 * registered from `trpc.router.ts` against those services — no addon
 * owns the cluster topology view.
 *
 * Phase E of the API consolidation: previously a hand-written core
 * router. Cap conversion lets `useNodesTopology`, `useNodesRestartNode`,
 * etc. flow through the same codegen pipeline as every other cap.
 */

// ── Topology ─────────────────────────────────────────────────────────

const TopologyServiceSchema = z.object({
  addonId: z.string(),
  capabilities: z.array(z.string()).readonly(),
  status: z.string(),
})

const TopologyProcessSchema = z.object({
  pid: z.number(),
  name: z.string(),
  state: z.string(),
  cpuPercent: z.number(),
  memoryRss: z.number(),
  uptimeSeconds: z.number(),
  services: z.array(TopologyServiceSchema).readonly(),
  groupId: z.string().optional(),
})

// Diagrams redesign (2026-05-20): topology now carries a per-node
// roll-up of addons by category, so the admin UI's Cluster page can
// render compact "category cards" without re-walking the whole
// `addons[]` + `processes[]` arrays on each frame.
const TopologyCategoryAddonSchema = z.object({
  id: z.string(),
  status: z.string(),
  cpuPercent: z.number(),
  memoryRss: z.number(),
})

const TopologyCategorySchema = z.object({
  category: z.string(),
  total: z.number(),
  healthy: z.number(),
  addons: z.array(TopologyCategoryAddonSchema).readonly(),
})

/**
 * The node's runtime-updatable ROOT package (`@camstack/server` — the single
 * root package for every node role) as reported by its `registerNode`
 * manifest — version visibility for the Server management surface. Nullable:
 * offline rows and nodes that never reported one.
 */
const TopologyRootPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
})

const TopologyNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  cpuModel: z.string().nullable(),
  cpuCores: z.number(),
  memoryMB: z.number(),
  /**
   * The inference RUNTIMES installed on the node (`pythonRuntimes`: onnx,
   * openvino, edgetpu …) — not its devices. An installed runtime says nothing
   * about whether its hardware is there (a Coral delegate stays installed
   * after the stick leaves, D919); the live device set is
   * `pipelineOrchestrator.getNodeInferenceDevices`.
   */
  engines: z.array(z.string()).readonly(),
  isHub: z.boolean(),
  isOnline: z.boolean(),
  cpuPercent: z.number(),
  memoryPercent: z.number(),
  uptime: z.number(),
  lastSeen: z.string(),
  localIps: z.array(z.string()).readonly(),
  addons: z
    .array(
      z.object({
        id: z.string(),
        capabilities: z.array(z.string()).readonly(),
        status: z.string(),
      }),
    )
    .readonly(),
  processes: z.array(TopologyProcessSchema).readonly(),
  categories: z.array(TopologyCategorySchema).readonly(),
  rootPackage: TopologyRootPackageSchema.nullable(),
  /**
   * How an online AGENT reaches the hub (mesh mTLS Release A): `tls` once it has
   * completed a mutual-TLS handshake, `clear` otherwise. Absent for the hub,
   * for offline rows and when the hub cannot tell.
   */
  meshTransport: z.enum(['tls', 'clear']).optional(),
  /**
   * Whether the hub holds this online AGENT's capability registration (its
   * `registerNode` manifest). `false` = online in the mesh but not ready: the
   * hub dropped the registration on a disconnect only it saw and the agent has
   * not re-sent it. Absent for the hub and offline rows.
   */
  capabilitiesRegistered: z.boolean().optional(),
})

// Observed runtime cap-usage edges — drives the Capability Flow tab on
// the Cluster page. Each edge counts cap calls made in a sliding window.
const CapUsageEdgeSchema = z.object({
  callerAddonId: z.string(),
  providerAddonId: z.string(),
  capName: z.string(),
  callsPerMin: z.number(),
  lastCallAtMs: z.number(),
})

// ── Cluster addon-status ────────────────────────────────────────────

const ClusterAddonNodeDeploymentSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.string(),
  synced: z.boolean(),
})

const ClusterAddonStatusEntrySchema = z.object({
  hubVersion: z.string(),
  nodes: z.array(ClusterAddonNodeDeploymentSchema),
})

// ── Method input/output shapes ──────────────────────────────────────

const NodeAddonInputSchema = z.object({
  nodeId: z.string(),
  addonId: z.string(),
})

const NodeAddonEntrySchema = z.object({
  id: z.string(),
  status: z.string(),
  version: z.string().optional(),
  packageName: z.string().optional(),
})

const SuccessSchema = z.object({ success: z.boolean() })

const RestartProcessResultSchema = z.object({
  success: z.boolean(),
  reason: z.string().optional(),
})

const RestartNodeResultSchema = z.object({
  restarted: z.array(z.string()).readonly(),
  failed: z.array(z.string()).readonly(),
})

const RenameNodeResultSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
})

/**
 * One row of the CHEAP node list (D637): what a node picker needs and nothing
 * else. Read from the hub's in-memory registry plus the durable node history.
 * No per-node RPC, unlike `topology`, which walks the whole cluster (32–51 s).
 */
export const NodeDirectoryEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  isHub: z.boolean(),
  isOnline: z.boolean(),
})
export type NodeDirectoryEntry = z.infer<typeof NodeDirectoryEntrySchema>

/**
 * The cheap node list. A consumer's rule for a STORED node id (a rule's
 * `nodeIds`) that is missing from `nodes`, whatever `complete` says: render it
 * as a removable chip labelled unknown, never drop it (D49). Even a complete
 * list omits a node that joined and left between two history captures, so a
 * missing id means "not known to the hub", never "removed". Only the operator
 * removes it.
 *
 * `complete` changes only the WORDING: `false` = no history read has ever
 * answered, so the list may be missing offline nodes the hub does know (D315).
 *
 * `name` is the history row's name (≤ 30 s behind a rename), or the id when
 * the history has none.
 */
export const NodeDirectorySchema = z.object({
  nodes: z.array(NodeDirectoryEntrySchema).readonly(),
  complete: z.boolean(),
})
export type NodeDirectory = z.infer<typeof NodeDirectorySchema>

/**
 * `nodes` is a **hub-centric** cluster-management cap: the hub hosts
 * the single provider and every per-node method (`getNodeAddons`,
 * `restartProcess`, `restartNode`, `undeployAddon`, …) takes `nodeId`
 * as DATA — the provider fans out to the target node itself via
 * `broker.call(..., { nodeID })`. Agents host no `nodes` provider.
 *
 * `nodeIdMode: 'data'` therefore forwards `nodeId` to the hub provider
 * intact instead of stripping it for generic cap-router node routing
 * (which would reject any non-hub `nodeId` with "Node routing not
 * available", since `nodes` is mounted as a hub singleton).
 */
export const nodesCapability = {
  name: 'nodes',
  scope: 'system',
  mode: 'singleton',
  nodeIdMode: 'data',
  methods: {
    topology: method(z.void(), z.array(TopologyNodeSchema).readonly(), { auth: 'admin' }),
    /**
     * The cheap node list for pickers (D637): the hub's in-memory registry plus
     * the durable node history, no per-node RPC. `complete: false` when the
     * history could not be read.
     */
    directory: method(z.void(), NodeDirectorySchema, { auth: 'admin' }),
    deployAddon: method(NodeAddonInputSchema, SuccessSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    undeployAddon: method(NodeAddonInputSchema, SuccessSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    restartAddon: method(NodeAddonInputSchema, SuccessSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    restartProcess: method(
      z.object({ nodeId: z.string(), processName: z.string() }),
      RestartProcessResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    restartNode: method(z.object({ nodeId: z.string() }), RestartNodeResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    shutdownNode: method(z.object({ nodeId: z.string() }), SuccessSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    renameNode: method(
      z.object({ nodeId: z.string(), name: z.string().min(1).max(64) }),
      RenameNodeResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    clusterAddonStatus: method(z.void(), z.record(z.string(), ClusterAddonStatusEntrySchema), {
      auth: 'admin',
    }),
    getCapUsageGraph: method(
      z.object({
        windowSeconds: z.number().int().positive().max(300).default(60),
      }),
      z.array(CapUsageEdgeSchema).readonly(),
      { auth: 'admin' },
    ),
    /**
     * Direct per-node addon listing — calls `$agent.status` on the target
     * node (or returns the hub registry for `nodeId === 'hub'`) and surfaces
     * the full addon roster including `version` + `packageName`. The
     * `topology` cap also includes addons but strips them down to
     * `{id, capabilities, status}` for the cluster diagram; this method
     * is the one the per-node "Addons" tab should call.
     */
    getNodeAddons: method(
      z.object({ nodeId: z.string() }),
      z.array(NodeAddonEntrySchema).readonly(),
      { auth: 'admin' },
    ),
    setProcessLogLevel: method(z.object({ nodeId: z.string(), level: z.string() }), SuccessSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    executeQuery: method(
      z.object({
        nodeId: z.string(),
        addonId: z.string(),
        queryName: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
      z.unknown(),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/system` `buildCapRouters`. */
  mount: { kind: 'server-provided' },
} as const satisfies CapabilityDefinition

export type INodesProvider = InferProvider<typeof nodesCapability>

export {
  TopologyNodeSchema,
  TopologyProcessSchema,
  TopologyRootPackageSchema,
  TopologyServiceSchema,
  ClusterAddonStatusEntrySchema,
  ClusterAddonNodeDeploymentSchema,
  NodeAddonEntrySchema,
}
