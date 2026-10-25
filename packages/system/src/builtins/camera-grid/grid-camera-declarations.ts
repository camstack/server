/**
 * Turning persisted grid rows into the camera declarations `DeclaredDevices`
 * reconciles.
 *
 * Modelled on `terminal-camera-declarations.ts`, and for the same reasons: the
 * declaration set is the ONLY thing standing between a transient RPC failure
 * and a sweep that deletes every camera this addon owns.
 */
import { DECLARED_DEVICE_SWEEP_LIMIT } from '@camstack/types'
import type { GridInstance } from './grid-instances.js'

/** The prefix every stable id this addon has ever minted starts with. */
const GRID_CAMERA_STABLE_ID_PREFIX = 'camera-grid-'

/**
 * The stable id is `camera-grid-<instance uuid>` and NOTHING else.
 *
 * A stable id is permanent the instant it is minted: bindings, grid layouts in
 * other addons, recording rows, the timeline and this addon's own tombstones
 * all reference it, and a device whose stable id changes is a NEW camera with
 * an empty history. So it may only be derived from something that itself never
 * changes.
 *
 * The instance uuid is the only such thing here. Deriving it from the NAME
 * would rename-break every reference; deriving it from the CELLS would mint a
 * new camera every time the operator drags a rectangle — which is the entire
 * activity this addon exists for. Terminal learned the same lesson from the
 * other end: its original one-camera-per-node id is permanent, and its profile
 * migration had to ENRICH that row rather than mint a replacement.
 */
export function newGridCameraStableId(instanceId: string): string {
  return `${GRID_CAMERA_STABLE_ID_PREFIX}${instanceId}`
}

/** The config a declared grid camera device carries. */
export interface GridCameraConfig {
  readonly instanceId: string
  /** `DeviceDeclaration.config` is an open record; this keeps the named type assignable. */
  readonly [key: string]: unknown
}

export interface GridCameraDeclaration {
  readonly stableId: string
  readonly name: string
  readonly config: GridCameraConfig
}

export interface ExistingGridCameraRow {
  readonly id: number
  readonly stableId: string
  readonly integrationId?: string | null
  readonly config: Readonly<Record<string, unknown>>
}

/**
 * Explicit persisted instances only. A grid camera exists because an operator
 * created a grid, never because some source camera happens to exist.
 *
 * A grid with NO cells is declared like any other: creation is name-only and
 * the layout is authored afterwards in the camera's own device details, so
 * "no cells yet" is the normal first state, not an invalid row.
 */
export function buildGridCameraDeclarations(
  instances: readonly GridInstance[],
): readonly GridCameraDeclaration[] {
  return instances
    .filter((instance) => instance.enabled)
    .map((instance) => ({
      stableId: instance.cameraStableId,
      name: instance.name,
      config: { instanceId: instance.id },
    }))
}

/**
 * The rows `DeclaredDevices` is allowed to consider — every live declaration
 * plus ONE bounded batch of orphans.
 *
 * Two guards, both copied from Terminal because both were paid for there:
 *
 * 1. **An unknown integration id yields an EMPTY index.** `null`/`undefined`
 *    means "the integration lookup has not answered", which is not the same
 *    fact as "this addon owns no rows" — and only the second one may drive a
 *    withdrawal.
 * 2. **The orphan batch is bounded and deterministically ordered.** The generic
 *    sweep refuses an over-limit set outright; selecting a batch here drains a
 *    large historical orphan set across passes without weakening that guard.
 */
export function gridCameraReconciliationIndex(
  rows: readonly ExistingGridCameraRow[],
  integrationId: string | null | undefined,
  declarations: readonly GridCameraDeclaration[],
  managedStableIds: ReadonlySet<string> = new Set(),
): readonly ExistingGridCameraRow[] {
  if (!integrationId) return []
  const declared = new Set(declarations.map((camera) => camera.stableId))
  const owned = rows.filter(
    (row) =>
      row.integrationId === integrationId &&
      (declared.has(row.stableId) ||
        managedStableIds.has(row.stableId) ||
        row.stableId.startsWith(GRID_CAMERA_STABLE_ID_PREFIX)),
  )
  return [
    ...owned.filter((row) => declared.has(row.stableId)),
    ...owned
      .filter((row) => !declared.has(row.stableId))
      .sort((left, right) => left.id - right.id)
      .slice(0, DECLARED_DEVICE_SWEEP_LIMIT),
  ]
}
