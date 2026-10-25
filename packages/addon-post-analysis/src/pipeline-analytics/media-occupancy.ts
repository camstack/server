/**
 * Event-media occupancy, per storage location (D388).
 *
 * `storage-evictable` cannot answer this: it reports the eviction DOMAIN and
 * reports zero for a location whose eviction policy is `never`. So the media
 * store answers `storage-occupancy` on its own terms — bytes HELD, per
 * location, including what retention would never remove.
 *
 * The only judgement in here is where the LEGACY rows go. A media row written
 * before multi-location stamps `locationId: null`, which means "wherever the
 * bare `eventMedia` type ref resolves". Resolving a bare type ref is the
 * orchestrator's rule, and this module applies the same one — sole location of
 * the type, else the `:default`-slugged row — and, crucially, ATTRIBUTES
 * NOTHING when neither applies. Spreading unattributable bytes over the
 * candidates, or dropping them onto the first one, would put a number on a
 * screen that no disk agrees with.
 */
import type { StorageOccupancyReport } from '@camstack/types'

/** The bare type ref legacy NULL-stamped media rows belong to. */
const LEGACY_MEDIA_TYPE = 'eventMedia'

/** What the store measured, before the legacy rows are placed. */
export interface MediaFootprintByLocation {
  readonly byLocation: ReadonlyMap<string, number>
  readonly legacyNullBytes: number
}

/**
 * Which of the requested locations the legacy `eventMedia` rows belong to, or
 * `null` when it cannot be decided — the same rule `resolveRef` applies, and
 * the same refusal when it is ambiguous.
 */
export function legacyMediaLocationOf(locationIds: readonly string[]): string | null {
  const ofType = locationIds.filter((id) => id.startsWith(`${LEGACY_MEDIA_TYPE}:`))
  if (ofType.length === 1) return ofType[0] ?? null
  return ofType.find((id) => id === `${LEGACY_MEDIA_TYPE}:default`) ?? null
}

/**
 * The occupancy reports for one measurement.
 *
 * A location with nothing on it is OMITTED, not reported as zero: only the
 * orchestrator knows whether nobody reported for a location or every reporter
 * holds nothing there, and it is the one that must be able to tell them apart.
 */
export function mediaOccupancyReports(
  footprint: MediaFootprintByLocation,
  locationIds: readonly string[],
  measuredAtMs: number,
): { reports: readonly StorageOccupancyReport[]; unattributedBytes: number } {
  const bytesByLocation = new Map(footprint.byLocation)
  const legacyTarget = footprint.legacyNullBytes > 0 ? legacyMediaLocationOf(locationIds) : null
  if (legacyTarget !== null) {
    bytesByLocation.set(
      legacyTarget,
      (bytesByLocation.get(legacyTarget) ?? 0) + footprint.legacyNullBytes,
    )
  }
  const reports: StorageOccupancyReport[] = []
  for (const [locationId, ownedBytes] of bytesByLocation) {
    if (ownedBytes <= 0) continue
    reports.push({ locationId, ownedBytes, measuredAtMs })
  }
  return {
    reports,
    unattributedBytes: legacyTarget === null ? footprint.legacyNullBytes : 0,
  }
}
