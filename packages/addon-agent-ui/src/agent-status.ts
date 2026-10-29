/**
 * What the agent status API returns, and the few pure helpers over it.
 * Kept out of `page.tsx` so panels and specs import it without mounting the app.
 */
import type { PairedHubInfo } from './paired-hub'

/**
 * Discriminated hub connection state returned by the agent status API.
 * Mirrors `HubConnectionState` in `packages/agent/src/agent-http.ts`.
 */
export type HubConnectionState =
  | 'connected'
  | 'unpaired'
  | 'unconfigured'
  | 'disconnected'
  | 'certificate-rejected'

export interface AgentStatus {
  readonly nodeId: string
  readonly name: string
  readonly platform: string
  readonly arch: string
  readonly hostname: string
  readonly cpuCores: number
  readonly cpuModel?: string
  readonly totalMemoryMB: number
  /** `null` when the memory read failed (D393). */
  readonly freeMemoryMB: number | null
  readonly cpuPercent: number
  /** `null` when the memory read failed (D393). */
  readonly memoryPercent: number | null
  readonly uptime: number
  readonly localIps: readonly string[]
  readonly addons: readonly {
    readonly id: string
    readonly status: string
    readonly version?: string
  }[]
  readonly hubAddress?: string | null
  /** The address the agent actually reaches the hub at, resolved from the
   *  Moleculer registry. */
  readonly resolvedHubAddress?: string | null
  /** HTTPS origin of the hub for Continue-with-hub unlock (D821). */
  readonly hubHttpsOrigin?: string | null
  /** Version of the Electron desktop wrapper (null when headless/Docker). */
  readonly appVersion?: string | null
  /** Product release (image / desktop). Null when the shell did not declare one. */
  readonly productVersion?: string | null
  /** Running `@camstack/server` package. Distinct from the product release. */
  readonly serverVersion?: string | null
  /** Legacy boolean — kept for backward compat with older agent builds. */
  readonly hubConnected?: boolean
  /** Richer discriminated state (present on agents with the P1 update). */
  readonly hubConnectionState?: HubConnectionState
  /** The other nodes in this agent's cluster registry (the hub among them). */
  readonly discoveredNodes?: readonly DiscoveredNode[]
  /** This agent holds a certificate from a hub's mesh CA (D857). */
  readonly paired?: boolean
  /** The hub it is paired with; absent on an agent that predates the field. */
  readonly pairedHub?: PairedHubInfo | null
  /** The agent process itself (distinct from host metrics). */
  readonly agentProcess?: AgentProcessInfo
  /** Decode hwaccel + DRI render node (light local probe). */
  readonly decode?: {
    readonly hwaccel: string
    readonly driDevice: string | null
  }
  /** Enabled detection accelerator keys (nvidia / intel / apple-ane / …). */
  readonly detectionDevices?: readonly string[]
}

export interface DiscoveredNode {
  readonly id: string
  readonly hostname: string
  /** Human label — hostname or IPv4; never only the opaque `hub` id when better data exists. */
  readonly displayName?: string
  readonly isHub: boolean
}

export interface AgentProcessInfo {
  readonly pid: number
  readonly uptimeSeconds: number
  readonly rssMB: number
  readonly heapUsedMB: number
  readonly heapTotalMB: number
}

/**
 * Derive the effective `HubConnectionState` from an `AgentStatus` response,
 * falling back to the legacy `hubConnected` boolean for older agent builds.
 */
export function resolveConnectionState(status: AgentStatus | null): HubConnectionState {
  if (status === null) return 'disconnected'
  if (status.hubConnectionState !== undefined) return status.hubConnectionState
  if (status.hubConnected === true) return 'connected'
  return 'disconnected'
}

/**
 * What a cluster node is called on screen: its display name (a hostname the
 * operator can recognise, else an IPv4); for the hub, whose container hostname
 * is an opaque id, the address this agent reaches it at. The opaque node id
 * stays a tooltip, never the label.
 */
export function discoveredLabel(node: DiscoveredNode, hubAddress: string | null): string {
  const name =
    node.isHub && hubAddress !== null && isOpaqueName(node.displayName ?? node.hostname)
      ? hubAddress
      : (node.displayName ?? node.hostname)
  return node.isHub ? `${name} (hub)` : name
}

/** A container id or node id: 12 or 64 hex digits — no operator ever chose it. */
export function isOpaqueName(name: string): boolean {
  return /^[0-9a-f]{12}$|^[0-9a-f]{64}$/.test(name)
}
