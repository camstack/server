/**
 * What `ops_update_check` and `ops_update_apply` share: the loose shapes the
 * hub answers with, the cluster read (every node comes from `nodes.topology`,
 * never from a list), the per-node server and wrapper verdicts, and the exact
 * instructions for a wrapper update the MCP never performs.
 *
 * A read that failed is a reason, never "up to date" (D315, D393).
 */
import type { HubClient } from '@camstack/develop'
import { z } from 'zod'
import { distinctCaps, isCapless, TopologyNodeSchema, TopologySchema } from './ops-status.js'
import { readQuery, type Read } from './ops-hub.js'

export type TopologyNode = z.infer<typeof TopologyNodeSchema>

const ImageContractShape = z.looseObject({
  state: z.enum(['in-sync', 'behind-patch', 'behind-series', 'ahead', 'unknown']),
  seedVersion: z.string().nullable(),
  contractVersion: z.string().nullable(),
  message: z.string().optional(),
})

const WrapperShape = z.looseObject({
  kind: z.enum(['docker', 'electron', 'native', 'contradictory', 'unknown']),
  currentVersion: z.string().nullable().optional(),
})

export const ServerStatusShape = z.looseObject({
  runningVersion: z.string().nullable(),
  installedVersion: z.string().nullable().optional(),
  latestVersion: z.string().nullable().optional(),
  pendingVersion: z.string().nullable().optional(),
  restartRequired: z.boolean().optional(),
  updateAvailable: z.boolean().optional(),
  updateState: z.string().optional(),
  lastCheckedAtMs: z.number().nullable().optional(),
  rolledBack: z
    .looseObject({
      fromVersion: z.string(),
      toVersion: z.string().nullable(),
      reason: z.string(),
    })
    .nullable()
    .optional(),
  imageContract: ImageContractShape.optional(),
  wrapper: WrapperShape.optional(),
})
export type ServerStatus = z.infer<typeof ServerStatusShape>

export const AddonUpdateShape = z.looseObject({
  name: z.string(),
  currentVersion: z.string(),
  latestVersion: z.string(),
  category: z.enum(['addon', 'core']),
  requiresRestart: z.boolean().optional(),
  isSystem: z.boolean(),
})
export type AddonUpdate = z.infer<typeof AddonUpdateShape>

export const InstallationsShape = z.looseObject({
  installations: z.array(
    z.looseObject({
      packageName: z.string(),
      nodeId: z.string(),
      isHub: z.boolean(),
      isOnline: z.boolean(),
      version: z.string().nullable(),
      onHub: z.boolean().optional(),
    }),
  ),
  unreachable: z.array(z.looseObject({ nodeId: z.string(), error: z.string() })),
})
export type Installations = z.infer<typeof InstallationsShape>

export const ServerActionShape = z.looseObject({
  accepted: z.boolean().optional(),
  outcome: z
    .enum(['staged', 'restart-scheduled', 'already-current', 'refused', 'failed'])
    .optional(),
  reason: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  message: z.string().optional(),
  blockers: z.array(z.looseObject({ addonId: z.string(), reason: z.string() })).optional(),
})

// ---------------------------------------------------------------------------
// reads

export function statusInput(node: {
  readonly isHub?: boolean
  readonly id: string
}): { readonly nodeId: string } | undefined {
  return node.isHub === true ? undefined : { nodeId: node.id }
}

export function readTopology(client: HubClient): Promise<Read<readonly TopologyNode[]>> {
  return readQuery(client, 'nodes.topology', undefined, TopologySchema)
}

export function readNodeStatus(
  client: HubClient,
  node: { readonly isHub?: boolean; readonly id: string },
): Promise<Read<ServerStatus>> {
  return readQuery(
    client,
    'serverManagement.getServerPackageStatus',
    statusInput(node),
    ServerStatusShape,
  )
}

export function readInstallations(client: HubClient): Promise<Read<Installations>> {
  return readQuery(client, 'addons.listInstallations', {}, InstallationsShape)
}

// ---------------------------------------------------------------------------
// verdicts

export interface ServerVerdict {
  readonly running: string | null
  readonly installed: string | null
  readonly latest: string | null
  readonly pending: string | null
  readonly updateAvailable: boolean | null
  readonly restartRequired: boolean | null
  readonly updateState: string | null
  readonly rolledBack: {
    readonly from: string
    readonly to: string | null
    readonly reason: string
  } | null
  /** Age of the registry check `latest` came from; `null` = never checked. */
  readonly latestCheckedAt: string | null
}

export function serverVerdict(status: ServerStatus): ServerVerdict {
  return {
    running: status.runningVersion,
    installed: status.installedVersion ?? null,
    latest: status.latestVersion ?? null,
    pending: status.pendingVersion ?? null,
    updateAvailable: status.updateAvailable ?? null,
    restartRequired: status.restartRequired ?? null,
    updateState: status.updateState ?? null,
    rolledBack: status.rolledBack
      ? {
          from: status.rolledBack.fromVersion,
          to: status.rolledBack.toVersion,
          reason: status.rolledBack.reason,
        }
      : null,
    latestCheckedAt:
      status.lastCheckedAtMs !== undefined && status.lastCheckedAtMs !== null
        ? new Date(status.lastCheckedAtMs).toISOString()
        : null,
  }
}

export type WrapperKind = 'docker' | 'electron' | 'native' | 'contradictory' | 'unknown'

export interface WrapperVerdict {
  readonly kind: WrapperKind | null
  /** `null`: nothing was proved either way (no contract, `unknown`, `ahead`). */
  readonly behind: boolean | null
  readonly state: string | null
  readonly from: string | null
  readonly to: string | null
  readonly message: string | null
  /** Present only when `behind`; the MCP never performs these. */
  readonly instructions: readonly string[]
}

export function wrapperInstructions(kind: WrapperKind | null): readonly string[] {
  switch (kind) {
    case 'docker':
      return [
        'The image is replaced, not the closure: pull the new image and RECREATE the container (a plain restart keeps the old image).',
        'Docker Compose: `docker compose pull` then `docker compose up -d`.',
        'Unraid: Docker tab, "Check for updates", then apply the update on the CamStack container (it is recreated from the new image; keep the same appdata paths).',
        'Proxmox LXC: recreate the container the way it was installed; `setup_install_guide` with hostKind "proxmox-lxc" returns the official steps.',
        'Back up the data volume first; no tool here does it.',
      ]
    case 'electron':
      return [
        'Update the CamStack desktop app on that machine: install the new app version (the in-app update, or reinstall from the release) and let the app restart.',
        'The server closure update does not change the app bundle.',
      ]
    case 'native':
      return [
        'This node runs as a bare host process: update the package or service that starts it (the starter is not delivered by the closure update), then restart the service.',
      ]
    default:
      return [
        'The shell this node runs in could not be identified; check how it was installed (`setup_install_guide` lists the routes) and update it that way.',
      ]
  }
}

export function wrapperVerdict(status: ServerStatus): WrapperVerdict {
  const kind = status.wrapper?.kind ?? null
  const contract = status.imageContract
  if (contract === undefined) {
    return {
      kind,
      behind: null,
      state: null,
      from: null,
      to: null,
      message:
        'this node reports no image contract (its server predates it); the shell is unverified',
      instructions: [],
    }
  }
  const behind =
    contract.state === 'behind-patch' || contract.state === 'behind-series'
      ? true
      : contract.state === 'in-sync'
        ? false
        : null
  return {
    kind,
    behind,
    state: contract.state,
    from: contract.seedVersion,
    to: contract.contractVersion,
    message: contract.message ?? null,
    instructions: behind === true ? wrapperInstructions(kind) : [],
  }
}

/** Does the node's server closure need an apply? Unknown counts as "no claim". */
export function needsServerUpdate(verdict: ServerVerdict): boolean {
  return verdict.updateAvailable === true || verdict.restartRequired === true
}

export interface CapState {
  readonly count: number
  readonly capless: boolean
}

export function capState(node: TopologyNode): CapState {
  const count = distinctCaps(node)
  return { count, capless: isCapless(node, count) }
}

/** An addon package whose version on a node differs from the hub's. */
export interface AddonDrift {
  readonly packageName: string
  readonly nodeId: string
  readonly hubVersion: string
  readonly nodeVersion: string | null
}

export function addonDrift(installations: Installations): readonly AddonDrift[] {
  const hubVersion = new Map<string, string>()
  for (const row of installations.installations) {
    if (row.isHub && row.version !== null) hubVersion.set(row.packageName, row.version)
  }
  const drift: AddonDrift[] = []
  for (const row of installations.installations) {
    if (row.isHub) continue
    const hub = hubVersion.get(row.packageName)
    if (hub === undefined) continue
    if (row.version !== hub) {
      drift.push({
        packageName: row.packageName,
        nodeId: row.nodeId,
        hubVersion: hub,
        nodeVersion: row.version,
      })
    }
  }
  return drift
}
