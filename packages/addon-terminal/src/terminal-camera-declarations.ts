import { DECLARED_DEVICE_SWEEP_LIMIT } from '@camstack/types'
import type { TerminalInstance } from './terminal-instances.js'

export interface TerminalCameraNode {
  readonly id: string
  readonly name: string
  readonly isHub: boolean
}

export interface TerminalCameraDeclaration {
  readonly stableId: string
  readonly name: string
  readonly config: {
    readonly instanceId: string
    readonly nodeId: string
    readonly profileId: string
    readonly profileLabel: string
  }
}

export interface ExistingTerminalCamera {
  readonly stableId: string
  readonly config: Readonly<Record<string, unknown>>
}

export interface ExistingTerminalCameraRow extends ExistingTerminalCamera {
  readonly id: number
  readonly integrationId?: string | null
}

function stableIdFor(nodeId: string, profileId: string): string {
  // The original one-camera-per-node monitor id is intentionally permanent.
  // Existing installations use it in bindings and layouts, so a migration
  // must enrich its config rather than minting a replacement camera.
  return profileId === 'monitor'
    ? `terminal-camera-${nodeId}`
    : `terminal-camera-${nodeId}-${profileId}`
}

function nodeLabel(node: TerminalCameraNode): string {
  return node.isHub ? 'Hub' : node.name
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Reconstruct a declaration only when an existing row positively identifies
 * itself as a camera on `node`. This deliberately does not parse stable-id
 * prefixes: node and profile ids may both contain hyphens, and prefix parsing
 * used to preserve unrelated/malformed rows during a transient RPC outage.
 */
export function declarationFromExistingTerminalCamera(
  node: TerminalCameraNode,
  existing: ExistingTerminalCamera,
): TerminalCameraDeclaration | null {
  const configuredNodeId = asNonEmptyString(existing.config.nodeId)
  if (configuredNodeId !== node.id) return null

  const configuredProfileId = asNonEmptyString(existing.config.profileId)
  if (configuredProfileId !== null) {
    if (existing.stableId !== stableIdFor(node.id, configuredProfileId)) return null
    const profileLabel = asNonEmptyString(existing.config.profileLabel) ?? configuredProfileId
    return {
      stableId: existing.stableId,
      name: `Terminal ${profileLabel} - ${nodeLabel(node)}`,
      config: {
        instanceId: `legacy:${existing.stableId}`,
        nodeId: node.id,
        profileId: configuredProfileId,
        profileLabel,
      },
    }
  }

  // v1 created exactly one monitor camera per node and stored only `nodeId`.
  // Treat only that exact stable id as legacy — every other incomplete config
  // is invalid and is safely withdrawn by DeclaredDevices.
  if (existing.stableId !== stableIdFor(node.id, 'monitor')) return null
  return {
    stableId: existing.stableId,
    name: `Terminal BTM - ${nodeLabel(node)}`,
    config: {
      instanceId: `legacy:${existing.stableId}`,
      nodeId: node.id,
      profileId: 'monitor',
      profileLabel: 'BTM',
    },
  }
}

/**
 * Add rows back into a pass only when the node's profile RPC failed. A
 * successful response is authoritative: disabled/deleted profiles and removed
 * nodes remain absent so DeclaredDevices withdraws their rows.
 */
export function preserveUnavailableTerminalCameraDeclarations(
  declarations: readonly TerminalCameraDeclaration[],
  nodes: readonly TerminalCameraNode[],
  unavailableNodeIds: ReadonlySet<string>,
  existing: readonly ExistingTerminalCamera[],
  integrationId: string | null,
): readonly TerminalCameraDeclaration[] {
  const reconciled = new Map(declarations.map((declaration) => [declaration.stableId, declaration]))
  if (integrationId === null) return [...reconciled.values()]
  for (const camera of existing) {
    const nodeId = asNonEmptyString(camera.config.nodeId)
    if (!nodeId || !unavailableNodeIds.has(nodeId)) continue
    const node = nodes.find((candidate) => candidate.id === nodeId)
    if (!node) continue
    const preserved = declarationFromExistingTerminalCamera(node, camera)
    if (preserved) reconciled.set(preserved.stableId, preserved)
  }
  return [...reconciled.values()]
}

/**
 * Feed DeclaredDevices every live declaration plus one deterministic orphan
 * batch. The generic sweep intentionally refuses an over-limit set; selecting
 * a batch here drains large historical Terminal orphan sets across convergence
 * passes without weakening that global safety guard.
 */
export function terminalCameraReconciliationIndex(
  rows: readonly ExistingTerminalCameraRow[],
  integrationId: string | null | undefined,
  declarations: readonly TerminalCameraDeclaration[],
  managedStableIds: ReadonlySet<string> = new Set(),
): readonly ExistingTerminalCameraRow[] {
  if (!integrationId) return []
  const declared = new Set(declarations.map((camera) => camera.stableId))
  const owned = rows.filter(
    (row) =>
      row.integrationId === integrationId &&
      (declared.has(row.stableId) ||
        managedStableIds.has(row.stableId) ||
        row.stableId.startsWith('terminal-camera-instance-')),
  )
  return [
    ...owned.filter((row) => declared.has(row.stableId)),
    ...owned
      .filter((row) => !declared.has(row.stableId))
      .sort((left, right) => left.id - right.id)
      .slice(0, DECLARED_DEVICE_SWEEP_LIMIT),
  ]
}

/** Explicit persisted instances, never the node × profile template matrix. */
export function buildTerminalInstanceCameraDeclarations(
  instances: readonly TerminalInstance[],
): readonly TerminalCameraDeclaration[] {
  return instances
    .filter((instance) => instance.enabled)
    .map((instance) => ({
      stableId: instance.cameraStableId,
      name: instance.name,
      config: {
        instanceId: instance.id,
        nodeId: instance.nodeId,
        profileId: instance.profileId,
        profileLabel: instance.profileLabel,
      },
    }))
}

/**
 * `DeviceConfig` materializes schema defaults in memory, so comparing
 * `config.get()` cannot detect a legacy `{ nodeId }` row. Reconciliation must
 * inspect the raw persisted blob to make the profile migration durable.
 */
export function needsTerminalCameraConfigMigration(
  persistedConfig: Readonly<Record<string, unknown>>,
  declaration: TerminalCameraDeclaration,
): boolean {
  return (
    persistedConfig.instanceId !== declaration.config.instanceId ||
    persistedConfig.nodeId !== declaration.config.nodeId ||
    persistedConfig.profileId !== declaration.config.profileId ||
    persistedConfig.profileLabel !== declaration.config.profileLabel
  )
}
