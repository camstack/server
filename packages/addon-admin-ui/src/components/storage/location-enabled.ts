/**
 * Turning an operator's edit into a COMPLETE `storage.upsertLocation` payload.
 *
 * Two facts every surface writing a location has to agree with the server on:
 *
 *  - **A location's state is one enum, not two booleans.** `location-mode.ts`
 *    owns it (`active | readonly | drain | disabled`); this module only knows
 *    how to persist it. The legacy pair (`enabled`, `config.readOnly`) is
 *    written ALONGSIDE the new `mode` — derived from it, never a second
 *    authority — so a hub that has not yet learned `mode` still behaves as
 *    closely as its two flags allow.
 *  - **`upsertLocation` REPLACES.** Its input is the whole location minus the
 *    timestamps, and the record it writes is `{ ...input, createdAt, updatedAt }`.
 *    A payload assembled from a handful of fields therefore DELETES the rest —
 *    and the field that hurts is `nodeId`: a node-local location that arrives
 *    without one is re-stamped `'hub'`, silently moving an agent's disk to the
 *    hub. Every write from this surface goes through
 *    {@link toLocationUpsertInput}, which is built from the row that was read.
 */
import type { StorageLocation, StorageLocationDeclaration } from '@camstack/types'
import { type LocationMode, modeAcceptsWrites, resolveLocationMode } from './location-mode'

/**
 * Whether the operator may delete this location from the card.
 *
 * A location cannot be deleted if it is the only one of its type, or the only
 * one still accepting writes, or the declaration is `cardinality: 'single'`.
 */
export function locationDeletable(
  location: Pick<StorageLocation, 'id' | 'enabled' | 'config'>,
  siblings: readonly Pick<StorageLocation, 'id' | 'enabled' | 'config'>[],
  cardinality: StorageLocationDeclaration['cardinality'],
): boolean {
  if (cardinality === 'single') return false
  if (siblings.length <= 1) return false
  if (modeAcceptsWrites(resolveLocationMode(location))) {
    const writable = siblings.filter((s) => modeAcceptsWrites(resolveLocationMode(s)))
    if (writable.length <= 1) return false
  }
  return true
}

/** The fields an operator edit may set. Everything else is copied from the row. */
export interface LocationUpsertPatch {
  /** The four-way state. Absent leaves the stored state alone. */
  readonly mode?: LocationMode
  readonly displayName?: string
  /** Replaces the provider config wholesale (the Edit modal's form state). */
  readonly config?: Readonly<Record<string, unknown>>
  readonly nodeId?: string
}

/**
 * `storage.upsertLocation`'s input: the whole persisted location.
 *
 * `mode` is declared here because `StorageLocation` does not carry it yet in
 * this worktree — `@camstack/types` owns the field (D385/D386) and this
 * intersection collapses to nothing the moment it lands.
 */
export type LocationUpsertInput = Omit<StorageLocation, 'createdAt' | 'updatedAt' | 'capacity'> & {
  readonly mode?: LocationMode
}

/** The legacy pair a mode implies, for a hub that predates `mode`. */
interface LegacyModeFlags {
  readonly enabled: boolean
  readonly readOnly: boolean
}

function legacyFlagsFor(mode: LocationMode): LegacyModeFlags {
  // `disabled` has no legacy expression — no old flag ever hid footage from
  // the timeline. The closest an old hub can get is "no writes", which is what
  // it gets; `mode` is what makes it hide, on a hub that understands it.
  if (mode === 'active') return { enabled: true, readOnly: false }
  if (mode === 'readonly') return { enabled: false, readOnly: false }
  return { enabled: false, readOnly: true }
}

/**
 * Build a COMPLETE upsert payload from the row that was read, with `patch`
 * applied on top.
 *
 * `capacity` is dropped because it is computed at read time and never
 * persisted; the timestamps are dropped because the server owns them. A patch
 * that names no mode leaves `enabled` exactly as it was read — an unrelated
 * edit must not stamp a legacy row with a flag it never had.
 */
export function toLocationUpsertInput(
  location: StorageLocation,
  patch: LocationUpsertPatch,
): LocationUpsertInput {
  const config: Record<string, unknown> = { ...(patch.config ?? location.config) }
  if (patch.mode !== undefined) {
    const flags = legacyFlagsFor(patch.mode)
    if (flags.readOnly) config['readOnly'] = true
    else delete config['readOnly']
  }
  const base: LocationUpsertInput = {
    id: location.id,
    type: location.type,
    displayName: patch.displayName ?? location.displayName,
    providerId: location.providerId,
    config,
    isSystem: location.isSystem,
  }
  const nodeId = patch.nodeId ?? location.nodeId
  const withNode: LocationUpsertInput = nodeId === undefined ? base : { ...base, nodeId }
  if (patch.mode === undefined) {
    return location.enabled === undefined ? withNode : { ...withNode, enabled: location.enabled }
  }
  return { ...withNode, mode: patch.mode, enabled: legacyFlagsFor(patch.mode).enabled }
}
