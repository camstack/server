/**
 * How much of a volume CAMSTACK holds — the second question the capacity bar
 * has to answer, and the one that says whether the fix is ours.
 *
 * "The disk is 80% full" and "we hold 12% of it" are different decisions. The
 * hub's SSD carries `recordingsLow`, `eventMedia` and artifacts together; a
 * full volume there may be nothing to do with CamStack at all.
 *
 * ## Where the figure comes from, and where it does NOT exist
 *
 * `storage.listLocations` stamps `capacity` (the VOLUME's total/free) and
 * carries no per-location CamStack usage. The one measured figure available to
 * a UI is `recording.getStorageUsage().locations[]`: one row per PHYSICAL
 * volume, whose `usedBytes` is "bytes of recordings stored on this volume (all
 * aliases)" — exactly a share-of-the-volume figure, and exactly what
 * `storage-fill.ts` already calls `recordingsFraction`.
 *
 * It covers the recording classes and nothing else. `backups`, `eventMedia`
 * and artifact locations have no equivalent read, so they get **no segment** —
 * never a segment of zero. An unknown share drawn as empty states that we
 * occupy nothing, which is the D315 mistake this repo has already paid for.
 * Adding a per-location usage read to the orchestrator would cover the rest;
 * that is a backend change and it is not made here.
 */

/** One `RecordingLocationUsage` row, as far as this derivation reads it. */
export interface UsageRowFacts {
  readonly locationId: string | null
  /** Every location id sharing this row's physical volume. */
  readonly locationIds?: readonly string[]
  /** Bytes of recordings on that volume. */
  readonly usedBytes: number
}

/** The location as this derivation reads it. */
export interface OwnedUsageSubject {
  readonly id: string
  readonly type: string
}

/**
 * The location classes the recorder's usage rows account for. Every other
 * class is unmeasurable from the UI — a row that merely ALIASES one of those
 * ids (an `eventMedia` location sharing the recordings disk) still counts only
 * recordings, so attributing its bytes to that location would be a made-up
 * number wearing a measured label.
 */
export const MEASURED_USAGE_TYPES: readonly string[] = ['recordings', 'recordingsLow']

function idsOf(row: UsageRowFacts): readonly string[] {
  if (row.locationIds !== undefined && row.locationIds.length > 0) return row.locationIds
  return row.locationId === null ? [] : [row.locationId]
}

/**
 * Bytes CamStack holds on this location's volume, or `null` when there is no
 * measured figure — an unmeasurable class, a volume no row covers, or a
 * payload a hub's baked router stripped.
 */
export function resolveOwnedBytes(
  location: OwnedUsageSubject,
  rows: readonly UsageRowFacts[] | undefined,
): number | null {
  if (rows === undefined) return null
  if (!MEASURED_USAGE_TYPES.includes(location.type)) return null
  const row = rows.find((r) => idsOf(r).includes(location.id))
  if (row === undefined) return null
  if (!Number.isFinite(row.usedBytes) || row.usedBytes < 0) return null
  return row.usedBytes
}

/** Every location id → its measured bytes, for a group of cards. */
export function ownedBytesByLocation(
  locations: readonly OwnedUsageSubject[],
  rows: readonly UsageRowFacts[] | undefined,
): ReadonlyMap<string, number> {
  const byId = new Map<string, number>()
  for (const location of locations) {
    const bytes = resolveOwnedBytes(location, rows)
    if (bytes !== null) byId.set(location.id, bytes)
  }
  return byId
}
