import { DeviceFeature } from '@camstack/types'

/**
 * Pure derivation of a Dreame container's {@link DeviceFeature} flags + the
 * presence predicates that gate its map / AI / mow children. Extracted from
 * {@link DreameContainerDevice} so the gating logic is unit-testable without
 * constructing a live device handle or a heavy `DeviceContext`.
 *
 * The container's `features` getter and its `modelSupports*` predicates both
 * call into here with the resolved-handle capability snapshot, so a feature
 * flag and the corresponding child's presence STAY CONSISTENT by construction
 * (one predicate, two consumers).
 *
 * CONFIRMED-capability contract: every input is the live handle's capability
 * record. When the handle has NOT resolved the caller passes `null`, and every
 * predicate returns `false` — NEVER an optimistic `true`. A device whose handle
 * never connects therefore spawns NO map/mow children (and advertises no
 * map/mow/AI feature), instead of spawning optimistic children that would later
 * orphan. This is safe because the Dreame provider awaits broker login +
 * discovery + shadow-seed BEFORE the kernel restores the container devices
 * (`DreameProviderAddon.onInitialize` → `registry.restore`), so the handle is
 * already present when `getAccessoryChildren()` / `features` run on the normal
 * boot path; `null` here means the account genuinely failed to connect.
 */

/** The subset of vacuum capability flags the container's gating reads. */
export interface DreameVacuumCapabilitySnapshot {
  readonly canMap: boolean
  /** Model carries an on-board camera (LinkVisual video) — gates the camera +
   *  navigation child. */
  readonly hasCamera: boolean
  readonly hasAiObstacleDetection: boolean
  /**
   * Count of AI-obstacle toggles the model actually exposes (each becomes one
   * Switch child). `VacuumHasAi` gates on this being non-zero so the feature
   * flag ⇔ the spawned AI-switch children stay EXACTLY consistent — a model that
   * reports `hasAiObstacleDetection` but exposes no individual toggles spawns no
   * children and advertises no feature.
   */
  readonly aiFeatureCount: number
}

/** The subset of mower capability flags the container's gating reads. */
export interface DreameMowerCapabilitySnapshot {
  readonly canMap: boolean
  readonly canMowAllArea: boolean
  readonly canMowZones: boolean
  readonly canMowEdges: boolean
  readonly canMowSpots: boolean
}

/**
 * Whether a vacuum supports a cleaning map. `false` when the handle has not
 * resolved (`null`) — confirmed capability only, never optimistic.
 */
export function vacuumSupportsMap(caps: DreameVacuumCapabilitySnapshot | null): boolean {
  return caps?.canMap === true
}

/**
 * Whether a vacuum exposes AI obstacle detection (drives the AI-switch children
 * + the `VacuumHasAi` feature). Gated on at least one supported AI toggle so the
 * feature flag matches the spawned AI-switch children exactly; `false` when the
 * handle has not resolved.
 */
export function vacuumSupportsAi(caps: DreameVacuumCapabilitySnapshot | null): boolean {
  return caps !== null && caps.hasAiObstacleDetection && caps.aiFeatureCount > 0
}

/**
 * Whether a vacuum carries an on-board camera (LinkVisual video) — gates the
 * separate camera + navigation child. `false` when the handle has not resolved
 * (confirmed capability only, never optimistic).
 */
export function vacuumSupportsCamera(caps: DreameVacuumCapabilitySnapshot | null): boolean {
  return caps?.hasCamera === true
}

/**
 * Whether a mower supports a map. `false` when the handle has not resolved.
 */
export function mowerSupportsMap(caps: DreameMowerCapabilitySnapshot | null): boolean {
  return caps?.canMap === true
}

/**
 * Whether a mower supports targeted (all-area / zone / edge / spot) mowing —
 * gates the "Mow" action select + the `MowerHasTargetedMowing` feature. `false`
 * when the handle has not resolved.
 */
export function mowerSupportsTargetedMowing(caps: DreameMowerCapabilitySnapshot | null): boolean {
  if (caps === null) return false
  return caps.canMowAllArea || caps.canMowZones || caps.canMowEdges || caps.canMowSpots
}

/** Inputs to {@link deriveContainerFeatures} — one branch is populated per kind. */
export interface DreameContainerFeatureInput {
  readonly kind: 'vacuum' | 'mower' | 'unsupported'
  /** Resolved vacuum capability snapshot, or null when the handle is not up. */
  readonly vacuumCaps: DreameVacuumCapabilitySnapshot | null
  /** Resolved mower capability snapshot, or null when the handle is not up. */
  readonly mowerCaps: DreameMowerCapabilitySnapshot | null
}

/**
 * Derive the container's full {@link DeviceFeature} list from the resolved
 * handle. Always includes {@link DeviceFeature.Resyncable}; adds the
 * kind-specific map / AI / targeted-mowing flags gated on CONFIRMED capability,
 * using the SAME predicates that gate the corresponding accessory children.
 */
export function deriveContainerFeatures(
  input: DreameContainerFeatureInput,
): readonly DeviceFeature[] {
  const flags: DeviceFeature[] = [DeviceFeature.Resyncable]

  if (input.kind === 'vacuum') {
    if (vacuumSupportsMap(input.vacuumCaps)) flags.push(DeviceFeature.VacuumHasMap)
    if (vacuumSupportsAi(input.vacuumCaps)) flags.push(DeviceFeature.VacuumHasAi)
  } else if (input.kind === 'mower') {
    if (mowerSupportsMap(input.mowerCaps)) flags.push(DeviceFeature.MowerHasMap)
    if (mowerSupportsTargetedMowing(input.mowerCaps)) {
      flags.push(DeviceFeature.MowerHasTargetedMowing)
    }
  }

  return flags
}
