import type {
  EvictableUsage,
  EvictResult,
  IScopedLogger,
  IStorageEvictableProvider,
  IStorageOccupancyProvider,
  StorageOccupancyReport,
} from '@camstack/types'
import { selectEvictionsByBytes } from './evict-select.js'
import { type DeviceRegistryRead, OrphanDeviceLane } from './orphan-device-lane.js'
import type { SegmentStore } from './segment-store.js'
import type { Accounting, OldestSegments, SegmentRow } from './types.js'

/**
 * The archive READ this provider needs, as a contract rather than a class.
 *
 * Both questions used to be put to the in-RAM `RecordingIndex`, and both could
 * only be answered there by visiting every row it held. `SegmentHourLedger`
 * satisfies this against SQLite; a test satisfies it with four rows. What the
 * seam pins is the SHAPE of the question — a total, and a BOUNDED oldest-first
 * read — so a future implementation cannot quietly go back to materialising the
 * archive to answer either one.
 */
export interface EvictableArchive {
  /** Bytes / count / oldest / newest over a whole eviction domain, at once. */
  accountingForLocations(locationIds: ReadonlySet<string>): Promise<Accounting>
  /**
   * The oldest segments across the domain, enough to cover `targetBytes`.
   * `exhausted` = the stream ended first.
   */
  oldestSegments(locationIds: ReadonlySet<string>, targetBytes: number): Promise<OldestSegments>
  /**
   * The same bounded oldest-first read, narrowed to a set of cameras — the
   * dead-device tier's question. Narrowing is what makes an orphan's NEWEST
   * hour reachable while a live camera holds every older one; a page-local
   * re-sort of {@link oldestSegments} could never see it.
   */
  oldestSegmentsForDevices(
    locationIds: ReadonlySet<string>,
    deviceIds: ReadonlySet<number>,
    targetBytes: number,
  ): Promise<OldestSegments>
  /** Every camera holding footage in the domain. RAM-only — this runs on the
   *  disk-pressure path, where a failed read would have to become a verdict. */
  devicesWithFootage(locationIds: ReadonlySet<string>): ReadonlySet<number>
}

/**
 * WHY a segment was chosen — the operator's "did I lose footage of a camera I
 * still have?" question, answered at selection time.
 *
 * `oldest-first` is what this provider has always done and stays implicit in
 * the policy; naming it is what makes `orphaned-device` mean something.
 */
export type EvictionReason = 'orphaned-device' | 'oldest-first'

/** Per-device roll-up of one disk-pressure eviction round, for activity events. */
export interface EvictionDeviceSummary {
  readonly deviceId: number
  readonly locationId: string
  readonly segments: number
  readonly bytes: number
  readonly fromMs: number
  readonly toMs: number
  readonly reason: EvictionReason
}

export interface StorageEvictableDeps {
  /**
   * See {@link EvictableArchive}. The durable hour ledger in production, read
   * per call because it is null until the collection is declared and is dropped
   * again if that declaration fails. `null` ⇒ this provider reports NOTHING
   * evictable and deletes nothing: an archive we cannot measure must not be
   * deleted oldest-first on a guess.
   */
  readonly archive: () => EvictableArchive | null
  readonly store: SegmentStore
  /**
   * Map a locationId to its eviction DOMAIN — every locationId whose footage lives
   * on the SAME physical filesystem root, INCLUDING the argument itself. Locations
   * that alias one disk (e.g. `recordings:default` + `recordingsLow:default`, both
   * rooted at `/recordings`) MUST evict as one oldest-first pool: otherwise byte
   * relief on one alias deletes the newest footage while the other alias still
   * holds the old (the age-partition data-loss bug).
   *
   * Domain membership is keyed by `fs.realpathSync` of each location's resolved
   * root — NOT the resolved path string alone — so a symlinked/bind-aliased path
   * reaching the same disk collapses into one domain (a plain-string key would
   * miss it and silently re-partition). When realpath throws (root missing at
   * boot) the key falls back to the resolved string, keeping distinct roots
   * distinct (safe: over-partitions at worst, never merges two disks). Omitted →
   * each location is its own domain (`{locationId}`), preserving single-location
   * behaviour.
   */
  readonly resolveDomain?: (locationId: string) => ReadonlySet<string>
  /** Called after a successful eviction round with per-device summaries. */
  readonly onEvicted?: (summaries: readonly EvictionDeviceSummary[]) => void
  /**
   * True when a location's eviction policy is `never` (D385) — `readonly` and
   * `disabled`. Its footage is EXCLUDED from disk-pressure eviction: the
   * relocate mover empties a `readonly` disk and the evictor must not race that
   * by deleting oldest-first, and a `disabled` one is not the system's to
   * erase. (Deliberate age-partition: retention-age sweeps still prune both.)
   *
   * A `drain` location is NOT frozen — it is being shrunk on purpose, by the
   * growth-matched ratchet (D386), through this very provider.
   */
  readonly isEvictionFrozen?: (locationId: string) => boolean
  /**
   * Enumerate the devices the registry currently knows — the fallible read the
   * dead-device tier is gated on. REQUIRED rather than optional: a wiring miss
   * would silently revert the operator's ordering to plain oldest-first and
   * look exactly like a working system. A caller with no registry to ask says
   * so by answering `unanswered`, which is a decision rather than an omission.
   *
   * See {@link OrphanDeviceLane} for what is done with the answer, and for why
   * a failure here can only ever DEFER relief.
   */
  readonly deviceRegistry: () => Promise<DeviceRegistryRead>
  /** Injected by tests so the lane's corroboration gap is reachable. */
  readonly now?: () => number
  /** Test-only override of the lane's minimum gap between corroborating reads. */
  readonly orphanConfirmGapMs?: number
  /** Where a refusal is reported. A branch that drops work says so. */
  readonly logger: IScopedLogger
}

// Input types derived from the cap's provider interface — single source of
// truth, drift-safe (no inline object types on the method signatures).
type GetEvictableUsageInput = Parameters<IStorageEvictableProvider['getEvictableUsage']>[0]
type EvictInput = Parameters<IStorageEvictableProvider['evict']>[0]
type GetOccupancyInput = Parameters<IStorageOccupancyProvider['getOccupancy']>[0]

/**
 * Implements the `storage-evictable` cap surface for recording footage. The core
 * StoragePressureManager owns the trigger (per-location free-space monitoring); this
 * provider decides WHAT footage is expendable and deletes it via `SegmentStore.evict`,
 * which removes the file through the `storage` cap and de-indexes.
 *
 * ## Two tiers, one budget
 *
 * Footage of a camera the registry no longer knows is chosen BEFORE any age
 * comparison; within that tier, and in everything after it, still oldest-first.
 * The operator's rule is "when the disk fills, lose the dead cameras first",
 * and it applies under disk pressure ONLY — there is deliberately no
 * time-based sweep of dead-device footage, so a camera that is gone keeps its
 * footage until the space is actually needed.
 *
 * This changes the ORDER and not the amount: the two tiers share one
 * `targetBytes` budget, the second is asked only for what the first left
 * uncovered, and nothing is selected that plain oldest-first would not have
 * been willing to select eventually.
 *
 * The dead-device tier is gated by {@link OrphanDeviceLane} — a registry read
 * that fails, comes back empty, or contradicts itself arms nothing, and the
 * round degrades to exactly the oldest-first behaviour that predates the tier.
 *
 * The cap's `locationId` is used directly as the storage `location` (identity); see Plan 2d
 * notes. Wiring this class to the cap + the SegmentStore happens in Plan 2e.
 */
/**
 * One class, two cap surfaces: `storage-evictable` (what may be deleted under
 * pressure) and `storage-occupancy` (what is HELD, D388). They live together
 * because they read the same archive, and they are separate CAPS because they
 * are separate quantities — see `getOccupancy`.
 */
export class StorageEvictableProvider
  implements IStorageEvictableProvider, IStorageOccupancyProvider
{
  private readonly orphanLane: OrphanDeviceLane

  constructor(private readonly deps: StorageEvictableDeps) {
    this.orphanLane = new OrphanDeviceLane({
      readRegistry: deps.deviceRegistry,
      logger: deps.logger,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.orphanConfirmGapMs !== undefined ? { minGapMs: deps.orphanConfirmGapMs } : {}),
    })
  }

  /** The eviction domain of `locationId` — aliases sharing its disk, else
   *  itself — MINUS read-only members (drain mode: their bytes are neither
   *  reported evictable nor selected as victims). */
  private domainOf(locationId: string): ReadonlySet<string> {
    const domain = this.deps.resolveDomain?.(locationId) ?? new Set([locationId])
    if (!this.deps.isEvictionFrozen) return domain
    const writable = new Set<string>()
    for (const id of domain) if (!this.deps.isEvictionFrozen(id)) writable.add(id)
    return writable
  }

  /**
   * How many bytes this domain holds — ONE aggregation, no rows returned.
   *
   * The storage-pressure sweep asks this per managed location every 60 s, and
   * two locations aliasing one root make it twice a minute. It used to be a
   * walk over every indexed segment on the node (7.1 M rows live), which is
   * also why the whole archive had to stay resident to be walked.
   */
  async getEvictableUsage(input: GetEvictableUsageInput): Promise<EvictableUsage> {
    const archive = this.deps.archive()
    if (archive === null) {
      this.deps.logger.warn(
        'recorder: evictable usage unavailable — no footage archive to measure, reporting 0 evictable bytes',
        { meta: { locationId: input.locationId } },
      )
      return { bytes: 0 }
    }
    const acct = await archive.accountingForLocations(this.domainOf(input.locationId))
    return { bytes: acct.bytes }
  }

  /**
   * The `storage-occupancy` answer (D388) — a DIFFERENT quantity from
   * {@link getEvictableUsage}, and the difference is the whole reason the cap
   * exists:
   *
   *  - it is the location's OWN bytes, not its eviction domain's. Two aliases
   *    of one root report their own halves instead of the same combined total
   *    twice;
   *  - it counts a location whose eviction policy is `never` (a `readonly` or
   *    `disabled` disk), which `getEvictableUsage` deliberately reports as 0.
   *    Those are the disks an operator retiring hardware is staring at.
   *
   * A location this recorder holds nothing on is OMITTED, never reported as
   * zero, and an archive it cannot measure yields NO reports at all — unknown
   * is the truth when nothing could be read.
   */
  async getOccupancy(input: GetOccupancyInput): Promise<readonly StorageOccupancyReport[]> {
    const archive = this.deps.archive()
    if (archive === null) {
      this.deps.logger.warn(
        'recorder: occupancy unavailable — no footage archive to measure, reporting NOTHING ' +
          '(a location with no report reads as unknown, never as empty)',
        { meta: { locationIds: [...input.locationIds] } },
      )
      return []
    }
    const measuredAtMs = this.deps.now?.() ?? Date.now()
    const out: StorageOccupancyReport[] = []
    for (const locationId of input.locationIds) {
      const acct = await archive.accountingForLocations(new Set([locationId]))
      if (acct.bytes <= 0) continue
      out.push({ locationId, ownedBytes: acct.bytes, measuredAtMs })
    }
    return out
  }

  async evict(input: EvictInput): Promise<EvictResult> {
    const archive = this.deps.archive()
    if (archive === null) {
      this.deps.logger.warn(
        'recorder: disk-pressure eviction skipped — no footage archive to pick the oldest from',
        { meta: { locationId: input.locationId, targetBytes: input.targetBytes } },
      )
      return { reclaimedBytes: 0, exhausted: true }
    }
    const domain = this.domainOf(input.locationId)

    // ── Tier 1: cameras the registry has CONFIRMED are gone ────────────────
    // Chosen before any age comparison, oldest-first among themselves. Empty
    // whenever the lane is not armed — which is every failure mode of the
    // registry read, and the whole of a cold start.
    const orphans = await this.orphanLane.confirmedOrphans(archive.devicesWithFootage(domain))
    const orphanVictims =
      orphans.size === 0
        ? []
        : selectEvictionsByBytes(
            (await archive.oldestSegmentsForDevices(domain, orphans, input.targetBytes)).rows,
            input.targetBytes,
          )
    const orphanBytes = orphanVictims.reduce((sum, v) => sum + v.bytes, 0)

    // ── Tier 2: everything else, oldest-first (the pre-existing policy) ────
    // Asked only for what tier 1 left uncovered, so the two tiers spend ONE
    // budget: this reorders the round, it does not enlarge it.
    // Reclaim across the whole physical-root domain, oldest-first — so a disk shared
    // by two location ids is never eviction-partitioned by age. Bounded: to evict the
    // oldest you need THE OLDEST, not the archive sorted. The domain goes to the
    // archive as one set, so this is one oldest-first stream and never a per-location
    // merge.
    const remainingBytes = input.targetBytes - orphanBytes
    const oldest: OldestSegments =
      remainingBytes > 0
        ? await archive.oldestSegments(domain, remainingBytes)
        : { rows: [], exhausted: false }
    // The oldest-first stream is location-scoped, so it can hand back rows tier
    // 1 already took. Deleting a path twice is not harmless — the second delete
    // fails and is counted as a failure — so the overlap is dropped here.
    const taken = new Set(orphanVictims.map((v) => v.path))
    const ageCandidates = oldest.rows.filter((r) => !taken.has(r.path))
    const ageVictims = selectEvictionsByBytes(ageCandidates, remainingBytes)
    const victims = [...orphanVictims, ...ageVictims]

    // Delete each victim under ITS OWN location id. Domain aliases share a physical
    // root, but routing every row through its own location keeps `SegmentStore.evict`'s
    // per-location precondition (and its bucket-granular fast path) intact.
    const byLocation = new Map<string, SegmentRow[]>()
    for (const v of victims) {
      const group = byLocation.get(v.locationId)
      if (group) group.push(v)
      else byLocation.set(v.locationId, [v])
    }
    let reclaimedBytes = 0
    for (const [locationId, rows] of byLocation) {
      reclaimedBytes += await this.deps.store.evict(locationId, rows)
    }

    if (reclaimedBytes > 0 && this.deps.onEvicted) {
      this.deps.onEvicted(summarizeEvictionsByDevice(victims, orphans))
    }
    // `exhausted` now comes from the READ rather than from comparing two array
    // lengths: a bounded oldest-first stream cannot count what it deliberately did
    // not fetch, and `oldest.exhausted` is the archive saying the stream ended
    // before the target was covered. The core StoragePressureManager's actual stop
    // condition is `reclaimedBytes <= 0`, not this flag.
    //
    // Tier 1 covering the whole target leaves the age stream unread, and an
    // unread stream has not ended — `remainingBytes <= 0` yields
    // `exhausted: false`, which is the truth: there is more here to take.
    const exhausted = oldest.exhausted && ageVictims.length >= ageCandidates.length
    return { reclaimedBytes, exhausted }
  }
}

/** Group an eviction round's victims into per-(device, location) summaries (bytes
 * come from the pre-delete selection — partial delete failures may overstate
 * slightly). A domain round can span aliased locations, so each victim is bucketed
 * by its OWN `locationId` (not a single round-level location).
 *
 * `orphanDeviceIds` is the round's CONFIRMED-gone set and it decides each
 * summary's {@link EvictionReason}. Required rather than defaulted: the reason
 * is what the operator reads in the activity history, and a caller that forgot
 * to pass it would file every eviction as `oldest-first` — the one wrong
 * answer nothing downstream could detect. */
export function summarizeEvictionsByDevice(
  victims: readonly SegmentRow[],
  orphanDeviceIds: ReadonlySet<number>,
): EvictionDeviceSummary[] {
  const byKey = new Map<string, EvictionDeviceSummary>()
  for (const v of victims) {
    const key = `${v.deviceId} ${v.locationId}`
    const cur = byKey.get(key)
    if (cur === undefined) {
      byKey.set(key, {
        deviceId: v.deviceId,
        locationId: v.locationId,
        segments: 1,
        bytes: v.bytes,
        fromMs: v.startMs,
        toMs: v.startMs + v.durMs,
        // The round's confirmed-gone set decides this, not the row: a camera
        // is either gone or it is not, so its whole share of the round carries
        // one reason and the ops-log never files the same deletion twice.
        reason: orphanDeviceIds.has(v.deviceId) ? 'orphaned-device' : 'oldest-first',
      })
    } else {
      byKey.set(key, {
        ...cur,
        segments: cur.segments + 1,
        bytes: cur.bytes + v.bytes,
        fromMs: Math.min(cur.fromMs, v.startMs),
        toMs: Math.max(cur.toMs, v.startMs + v.durMs),
      })
    }
  }
  return [...byKey.values()]
}
