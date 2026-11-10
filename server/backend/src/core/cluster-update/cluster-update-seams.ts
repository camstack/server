/**
 * The I/O the cluster update performs, injected so the whole sequence —
 * backup, the hub's own restart, agents, addons — is testable end to end
 * without a cluster. Boot wiring (`build-cluster-update-seams.ts`) binds them
 * to the hub's services.
 */
import type {
  BackupRun,
  BackupTriggerResult,
  ClusterUpdateJob,
  IScopedLogger,
  ServerPackageStatus,
  ServerUpdateActionResult,
} from '@camstack/types'

/** One node as the topology reports it; only what the update decides on. */
export interface ClusterNodeView {
  readonly id: string
  readonly isHub: boolean
  readonly isOnline: boolean
  /** Agents report it; absent = not claimed (the hub, older agents). */
  readonly capabilitiesRegistered?: boolean
  /** Distinct capabilities across the node's addons. */
  readonly capabilityCount: number
}

/** The backup surface the update needs; `null` from the seam = no provider. */
export interface ClusterBackupClient {
  readonly trigger: (label: string) => Promise<BackupTriggerResult>
  readonly listRuns: () => Promise<readonly BackupRun[]>
}

/** An addon package the hub can update (framework packages excluded). */
export interface ClusterAddonUpdate {
  readonly name: string
  readonly currentVersion: string
  readonly latestVersion: string
}

export interface ClusterAddonUpdateResult {
  readonly success: boolean
  readonly error?: string
}

/** One package on one node, as `addons.listInstallations` reports it. */
export interface ClusterInstallation {
  readonly packageName: string
  readonly nodeId: string
  readonly isHub: boolean
  readonly isOnline: boolean
  readonly version: string | null
}

/** Durable job state: survives the hub restart the job itself causes. */
export interface ClusterUpdateJobStore {
  readonly load: () => ClusterUpdateJob | null
  readonly save: (job: ClusterUpdateJob) => void
}

export interface ClusterUpdateTimeouts {
  /** Waiting for a node to run the target after its apply. */
  readonly serverMs: number
  /** Waiting for agents to match the hub's addon versions. */
  readonly addonsMs: number
  /** Polling interval of every wait. */
  readonly pollMs: number
}

export interface ClusterUpdateSeams {
  readonly readTopology: () => Promise<readonly ClusterNodeView[]>
  /** `null` = the hub itself. */
  readonly readServerStatus: (nodeId: string | null) => Promise<ServerPackageStatus>
  /** `null` = the hub itself. May throw when the node restarts under the call. */
  readonly applyServerUpdate: (
    nodeId: string | null,
    version: string,
  ) => Promise<ServerUpdateActionResult>
  readonly getBackup: () => ClusterBackupClient | null
  readonly listAddonUpdates: () => Promise<readonly ClusterAddonUpdate[]>
  readonly updateAddon: (name: string, version: string) => Promise<ClusterAddonUpdateResult>
  readonly readInstallations: () => Promise<readonly ClusterInstallation[]>
  readonly store: ClusterUpdateJobStore
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly newId: () => string
  readonly timeouts: ClusterUpdateTimeouts
}

/** 16 min is the apply's own staging bound; a node then has to restart and register. */
export const DEFAULT_CLUSTER_UPDATE_TIMEOUTS: ClusterUpdateTimeouts = {
  serverMs: 30 * 60_000,
  addonsMs: 15 * 60_000,
  pollMs: 5_000,
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
