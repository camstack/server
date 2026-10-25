/**
 * Which disk a camera's footage is on, as far as `recording.getStorageUsage`
 * can currently answer it.
 *
 * ## What the cap gives us, and what it does not
 *
 * `getStorageUsage` returns per-camera rows (`{ deviceId, usedBytes, oldestMs,
 * … }`) and per-PHYSICAL-VOLUME rows (`{ locationId, locationIds, usedBytes,
 * … }`). Since D418 both halves are the same quantity — the durable hour
 * ledger's — but they are still not JOINED: the ledger's hour rows carry
 * `locationId`, and the cap's per-device row does not. So:
 *
 *  - **One volume ⇒ the answer is EXACT.** There is nowhere else the footage
 *    could be.
 *  - **Several volumes ⇒ the answer is the CLASS DEFAULT, and it is marked as
 *    such** (`exact: false`). Rendering a guess as a fact across a multi-disk
 *    install is how a column becomes a thing operators stop trusting; a marked
 *    approximation is honest and still useful.
 *  - **No volume ⇒ no answer.** Nothing is rendered rather than a dash that
 *    reads as "the disk is missing".
 *
 * Making it exact is a recorder-side change, not a UI one — see the module doc
 * on `StorageSection` for the exact seam.
 */

import i18n from '../../i18n/index'

/** One `RecordingLocationUsage` row, as far as this derivation reads it. */
export interface UsageLocationFacts {
  readonly locationId: string | null
  readonly locationIds?: readonly string[]
}

export interface DiskAttribution {
  /** Human label — the location `displayName`s sharing the physical volume. */
  readonly label: string
  /** True when the footage can only be on this volume. */
  readonly exact: boolean
}

/** Every location id a usage row covers (a row is one physical volume). */
function idsOf(row: UsageLocationFacts): readonly string[] {
  if (row.locationIds !== undefined && row.locationIds.length > 0) return row.locationIds
  return row.locationId === null ? [] : [row.locationId]
}

function labelFor(row: UsageLocationFacts, displayNameById: ReadonlyMap<string, string>): string {
  const ids = idsOf(row)
  if (ids.length === 0) return i18n.t('helpers.cameraDisk.defaultRoot')
  return ids.map((id) => displayNameById.get(id) ?? id).join(' + ')
}

/**
 * Resolve the disk to show for a camera row.
 *
 * @param usageLocations   `recording.getStorageUsage().locations`.
 * @param displayNameById  location id → `displayName`, from `storage.listLocations`.
 * @param defaultLocationId The default location of the recordings class, or
 *                          `null` when it is not known.
 */
export function resolveCameraDisk(
  usageLocations: readonly UsageLocationFacts[],
  displayNameById: ReadonlyMap<string, string>,
  defaultLocationId: string | null,
): DiskAttribution | null {
  if (usageLocations.length === 0) return null
  const first = usageLocations[0]
  if (usageLocations.length === 1 && first !== undefined) {
    return { label: labelFor(first, displayNameById), exact: true }
  }
  if (defaultLocationId === null) return null
  const owning = usageLocations.find((row) => idsOf(row).includes(defaultLocationId))
  if (owning === undefined) return null
  return { label: labelFor(owning, displayNameById), exact: false }
}
