/**
 * The per-CAMERA half of `recording.getStorageUsage` — an ARCHIVE question
 * (D418).
 *
 * ## What this file exists to prevent
 *
 * One response used to carry two kinds of number under names that suggested
 * they matched: `locations[].usedBytes` from the durable hour ledger (the
 * archive — 1.9 TB on the live hub), and `devices[].usedBytes` / `oldestMs`
 * from `RecordingIndex` (RESIDENCY — 60.5 GB, oldest "three hours ago", on an
 * archive holding 3.3 days). On 2026-09-09 an operator and an assistant both
 * read the camera rows as history and spent a day chasing an eviction bug that
 * did not exist.
 *
 * Both halves now come from the ledger. The resident numbers are still
 * reported, because "what can this process serve without touching the disk" is
 * a real question — under names that say so.
 */
import type { IScopedLogger, RecordingDeviceUsage } from '@camstack/types'
import type { Accounting, ArchiveDeviceUsage } from '../types.js'
import type { SegmentHourLedger } from './segment-hour-ledger.js'

/**
 * Gap between the per-camera sum and the per-volume total that is worth
 * saying out loud, as a share of the volume total.
 *
 * The two are aggregations of the SAME hour rows over the same location set —
 * one folded per camera, one summed in SQL — so in a healthy recorder they
 * agree to the byte. A few tenths of a percent is a write landing between the
 * two reads; 97% (60.5 GB against 1.9 TB) is the defect this file closes,
 * rebuilt somewhere new.
 */
const USAGE_MISMATCH_SHARE = 0.02

/** Floor under {@link USAGE_MISMATCH_SHARE} so a nearly empty disk does not
 *  warn on a single in-flight segment. */
const USAGE_MISMATCH_FLOOR_BYTES = 1_000_000_000

/** Where `devices[]` was answered from. `unavailable` is a REFUSAL — this node
 *  has no hour ledger, its load has not answered, or no location resolved yet —
 *  and never "the cameras hold nothing". */
export type DeviceUsageRead = 'archive' | 'unavailable'

/** What {@link buildDeviceUsage} was given. */
export interface DeviceUsageInput {
  /** The resolvable recordings locations. Footage stranded on an id that no
   *  longer resolves stays invisible here, exactly as it was before D418 — a
   *  camera whose bytes no volume row accounts for is worse than a missing one. */
  readonly locationIds: ReadonlySet<string>
  /** The ARCHIVE's per-camera answer, or `null` when this node has no ledger. */
  readonly archive: ReadonlyMap<number, ArchiveDeviceUsage> | null
  /** What the RAM index currently holds for one camera. Reported, never used
   *  for `usedBytes` / `oldestMs`. */
  readonly resident: (deviceId: number) => Accounting
  readonly logger: IScopedLogger
}

/** The per-camera rows plus the two facts a caller must not have to re-derive. */
export interface DeviceUsageResult {
  readonly devices: readonly RecordingDeviceUsage[]
  readonly totalUsedBytes: number
  readonly read: DeviceUsageRead
}

/**
 * One row per camera the ARCHIVE holds footage for on `locationIds`, biggest
 * first (deviceId breaks a tie, so two consecutive calls compare).
 *
 * A node with no ledger REFUSES (D295 rule 3): empty rows, `read:
 * 'unavailable'`, and a line saying so. Falling back to the index would answer
 * the same question with the wrong quantity and look exactly like a correct
 * answer, which is how this shipped in the first place.
 */
export function buildDeviceUsage(input: DeviceUsageInput): DeviceUsageResult {
  if (input.archive === null) {
    input.logger.warn(
      'recorder: the hour ledger is absent or not loaded on this node — the per-camera storage rows are UNANSWERED, not empty',
      { meta: { locations: [...input.locationIds].toSorted().join(',') } },
    )
    return { devices: [], totalUsedBytes: 0, read: 'unavailable' }
  }

  const devices: RecordingDeviceUsage[] = []
  let totalUsedBytes = 0
  for (const [deviceId, archived] of input.archive) {
    const resident = input.resident(deviceId)
    totalUsedBytes += archived.bytes
    devices.push({
      deviceId,
      usedBytes: archived.bytes,
      oldestMs: archived.oldestMs,
      segments: archived.segments,
      residentBytes: resident.bytes,
      residentOldestMs: resident.oldestMs,
    })
  }
  return {
    devices: devices.toSorted((a, b) => b.usedBytes - a.usedBytes || a.deviceId - b.deviceId),
    totalUsedBytes,
    read: 'archive',
  }
}

/**
 * Say it when the per-camera sum and the per-volume total disagree.
 *
 * The "I saw N of M" rule of D295, applied to a REPORT: these two numbers are
 * the same rows counted two ways, so a gap means one of the two reads saw a
 * fraction of the archive — and the whole point of D418 is that a page which
 * shows both without comparing them lets a 97% gap read as a fact about the
 * disks.
 */
export function warnOnUsageMismatch(
  logger: IScopedLogger,
  deviceBytes: number,
  volumeBytes: number,
  read: DeviceUsageRead,
): void {
  if (read !== 'archive') return
  // A per-volume total of 0 is what a node with no ledger aggregation reports
  // (`archiveAccounting` absent) — "not asked", not "an empty disk". Comparing
  // a real per-camera sum against it would warn on every such node, which is
  // how a warning stops being read.
  if (volumeBytes === 0) return
  const gap = Math.abs(volumeBytes - deviceBytes)
  if (gap <= USAGE_MISMATCH_FLOOR_BYTES) return
  if (gap <= volumeBytes * USAGE_MISMATCH_SHARE) return
  logger.warn(
    'recorder: the per-camera storage sum disagrees with the per-volume total — one of the two reads saw a fraction of the archive',
    { meta: { deviceBytes, volumeBytes, gap } },
  )
}

/** The slice of {@link SegmentHourLedger} the per-camera rows are read from. */
export type ArchiveUsageSource = Pick<
  SegmentHourLedger,
  'hasLoaded' | 'isComplete' | 'usageByDevice' | 'retryLoadIfUnanswered'
>

/**
 * The per-camera archive rows, or `null` — a REFUSAL — when they would not be
 * the archive (D674, review C1).
 *
 * The recorder registers its providers before `onHubReachable` loads the
 * ledger, and a failed load used to last the runner's life. In both windows the
 * mirror holds only the rows written since boot, and `usageByDevice` folded
 * them into a confident `devicesRead: 'archive'` answer — which the retention
 * floor reads, so every follow-recordings camera was swept on a floor that was
 * too young. Now:
 *
 *  - no ledger, or a load that has not answered (including mid-load) ⇒ `null`,
 *    and an unanswered load is retried (bounded, never awaited);
 *  - no resolved location yet ⇒ `null`: an empty id set folds to "no camera
 *    has footage", which is not what an unresolved location means.
 */
export function archiveDeviceUsageOf(
  ledger: ArchiveUsageSource | null,
  locationIds: ReadonlySet<string>,
): ReadonlyMap<number, ArchiveDeviceUsage> | null {
  if (ledger === null) return null
  if (!ledger.hasLoaded()) {
    ledger.retryLoadIfUnanswered()
    return null
  }
  if (locationIds.size === 0) return null
  return ledger.usageByDevice(locationIds)
}

/**
 * Is an `archive` answer WHOLE — may a camera ABSENT from it be read as "no
 * footage"? Only when the ledger loaded without hitting its row cap and at
 * least one location resolved. The storage-usage response carries this as
 * `complete` (D674, review M2).
 */
export function archiveUsageComplete(
  ledger: ArchiveUsageSource | null,
  locationIds: ReadonlySet<string>,
): boolean {
  return ledger !== null && ledger.isComplete() && locationIds.size > 0
}
