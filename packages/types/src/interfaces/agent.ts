export interface AgentInfo {
  readonly id: string
  readonly name: string
  readonly capabilities: readonly string[]
  readonly host: string
  readonly port: number
  readonly resources?: AgentResources
}

export interface AgentResources {
  readonly cpuCores?: number
  readonly memoryMB?: number
  readonly gpuAvailable?: boolean
  readonly gpuModel?: string
}

export interface AgentStatus {
  readonly id: string
  readonly name: string
  readonly state: 'online' | 'offline' | 'degraded'
  readonly capabilities: readonly string[]
  readonly lastHeartbeat: number
  readonly connectedSince?: number
  readonly resources?: AgentResources
  readonly activeTaskCount: number
  readonly completedTaskCount: number
  readonly failedTaskCount: number
}

export interface AgentTask {
  readonly id: string
  readonly capability: string
  readonly input: Record<string, unknown>
  readonly timeout: number
  readonly priority: 'low' | 'normal' | 'high'
  readonly label?: string
}

export interface AgentTaskResult {
  readonly taskId: string
  readonly agentId: string
  readonly status: 'success' | 'error' | 'timeout'
  readonly output?: Record<string, unknown>
  readonly error?: string
  readonly durationMs: number
}

export interface TaskDispatchOptions {
  readonly preferredAgent?: string
  readonly capability: string
  readonly remoteOnly?: boolean
}

export interface AgentEntry {
  readonly info: AgentInfo
  state: 'online' | 'offline' | 'degraded'
  connectedSince: number
  lastHeartbeat: number
  activeTaskCount: number
  completedTaskCount: number
  failedTaskCount: number
}

/**
 * Compact health summary returned by `$agent.health` and the hub
 * `/health/agents/:nodeId` endpoint. Distinct from `$agent.status` —
 * health is a fast probe shape (no expensive metrics, fixed schema)
 * suitable for monitoring/k8s/uptime checks.
 */
export interface AgentHealth {
  readonly ok: boolean
  readonly nodeId: string
  readonly name: string
  readonly version: string
  readonly uptimeSeconds: number
  readonly pid: number
  readonly hubConnected: boolean
  readonly hubAddress: string | null
  readonly addons: AgentHealthAddonCounts
  readonly cpuPercent: number
  readonly memoryPercent: number
  /** ISO timestamp when this snapshot was generated. */
  readonly checkedAt: string
}

export interface AgentHealthAddonCounts {
  readonly total: number
  readonly running: number
  readonly error: number
}

/** Hub self-health, returned by `GET /health`. */
export interface HubHealth {
  readonly ok: boolean
  readonly nodeId: 'hub'
  readonly version: string
  readonly uptimeSeconds: number
  readonly pid: number
  readonly agents: HubHealthAgentCounts
  readonly cpuPercent: number
  readonly memoryPercent: number
  readonly checkedAt: string
  /**
   * The runner boot check (D877). Absent until it has run (~60 s after boot).
   * `ok` is NOT flipped by it - a container restart cannot fix a refused addon -
   * so a monitor that wants "degraded" reads `runners.degraded`.
   */
  readonly runners?: HubHealthRunners
}

export interface HubHealthRunners {
  readonly degraded: boolean
  readonly expected: number
  readonly running: number
  readonly failed: number
  readonly refused: number
  readonly missing: number
  readonly checkedAtMs: number
}

export interface HubHealthAgentCounts {
  readonly total: number
  readonly online: number
  readonly offline: number
  /**
   * Node ids of the offline agents. Optional (added later) — consumers
   * must tolerate absence on older hubs. Lets health surfaces name the
   * degraded node ("node agent-a not responding") instead of
   * only counting it.
   */
  readonly offlineIds?: readonly string[]
}

/** Aggregate cluster health, returned by `GET /health/cluster`. */
export interface ClusterHealth {
  readonly ok: boolean
  readonly hub: HubHealth
  readonly agents: ReadonlyArray<AgentHealth | AgentHealthError>
  readonly checkedAt: string
}

export interface AgentHealthError {
  readonly ok: false
  readonly nodeId: string
  readonly error: string
}

/** Shape returned by agents.listAgents — enriched agent entry with status and process info */
export interface AgentListItem {
  readonly info: {
    readonly id: string
    readonly name: string
    readonly hostname?: string
    readonly capabilities: readonly string[]
    readonly host?: string
    readonly port?: number
    readonly platform?: string
    readonly arch?: string
    readonly cpuModel?: string
    readonly cpuCores?: number
    readonly memoryMB?: number
    readonly gpuAvailable?: boolean
    readonly gpuModel?: string
    readonly pythonRuntimes?: readonly string[]
    readonly httpPort?: number
    readonly installedAddons?: readonly string[]
  }
  readonly status: {
    readonly activeCameras: number
    readonly cpuPercent: number
    readonly memoryPercent: number
    readonly fps: Readonly<Record<string, number>>
    readonly errors: readonly string[]
  }
  readonly connectedSince: number
  readonly isHub: boolean
  readonly isOnline?: boolean
  readonly subProcesses: readonly unknown[]
  /** Addon IDs reported by $agent.status (for non-hub nodes) */
  readonly agentAddons?: readonly string[]
  /** Local IP addresses visible on the network */
  readonly localIps?: readonly string[]
}

/**
 * Fan-out-free node liveness row for the `/health` surface, read from the
 * hub's in-memory Moleculer node registry (`broker.registry.getNodeList`)
 * — never a per-node RPC. `isOnline` is Moleculer's own availability
 * verdict (`node.available`); a node that disconnected cleanly (or missed
 * heartbeats) stays listed as offline until Moleculer purges it
 * (~cleanOfflineNodesTimeout), which is what lets `/health` NAME the
 * degraded node in `agents.offlineIds`.
 */
export interface NodeLiveness {
  readonly id: string
  readonly isHub: boolean
  readonly isOnline: boolean
}
