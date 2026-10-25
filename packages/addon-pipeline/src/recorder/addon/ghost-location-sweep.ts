/**
 * The ghost-location reconcile: durable hour rows stamped with a `locationId`
 * the storage record no longer has.
 *
 * ## What it cleans
 *
 * On 2026-08-30 this hub carried 32 hour rows / 2 131 segments / 15.1 GB
 * stamped `recordings:high` — an id `storage.listLocations` does not know. Such
 * a row is not merely untidy, it is three separate lies at once:
 *
 * - the eviction domain is built from CURRENT location ids
 *   (`eviction-domain.ts`), so the bytes are never victim candidates and the
 *   space is never reclaimed;
 * - `collectRangeSegments` drops rows whose location does not resolve
 *   (`recording-provider.ts:404`), so playback cannot reach them;
 * - the census `MIN(minStartMs)` includes them, so every device reports an
 *   `oldestMs` the evictable stream does not start at, and any retention
 *   arithmetic reading that floor is wrong.
 *
 * Since D293 `deleteLocation` refuses a location it cannot verify empty, so
 * new ghosts are rare by construction. This is the cleanup for the ones
 * already standing, and the net under a `force` delete.
 *
 * ## The D148 contradiction, and how this resolves it
 *
 * D148 is explicit that the ledger forgets an hour only when a TRUSTED WALK or
 * an EVICTION confirmed it gone. A ghost row has no root to walk: the id does
 * not resolve, so there is no directory to read and `hydrateDeviceFromStorage`
 * skips it forever. Under D148 as written, a ghost row can never be forgotten
 * by any mechanism — which is why the live ones have stood for thirteen days.
 *
 * The resolution is that the ghost row's root does not resolve but its hour
 * DIRECTORY is addressable anywhere: the path convention
 * (`104/high/2026/08/15/04/`) is a function of the row's own fields, so the same
 * hour can be listed under every currently-resolvable root. **A listing of the
 * hour directory at every candidate root is exactly the walk D148 sanctions,
 * done one root at a time.** That, and nothing weaker, is what licenses the
 * forget. Two consequences ride with it:
 *
 * - **Every root must answer.** An hour is forgotten only when every candidate
 *   root listed its directory and every one of them came back EMPTY. One root
 *   that could not answer and the hour stands.
 * - **An error is not an absence** (D49). A listing that fails, or that reports
 *   "I could not decide", ends the hour with nothing decided — never "not
 *   found". Whether an absent directory means "empty" or "this disk is gone" is
 *   the lister's question, and it answers it by reading the ROOT.
 *
 * Until D523 this probed each of the row's `paths` at each root, one
 * `storage.exists` at a time — up to ~1 000 syscalls to prove one hour absent.
 * The column is gone and the row names no file, so the unit is the directory,
 * which is both cheaper and the same evidence.
 *
 * ## Repoint versus forget
 *
 * The asymmetry is the whole safety argument, and it is deliberately cheap in
 * the safe direction:
 *
 * - **a non-empty listing at any root ⇒ the row is MIS-POINTED, not orphaned.**
 *   It is repointed to that root's location, with the segments that listing
 *   names, and the hour is finished. A renamed or re-created location produces
 *   exactly this shape, and deleting here would destroy the index of footage
 *   that EXISTS, which is the failure D291 was written to prevent.
 * - **every root lists an EMPTY hour ⇒ orphaned**, and only then forgotten.
 *
 * ## Pacing
 *
 * The recordings array is the resource every live read competes for. This is a
 * janitor: bounded hours per pass, a hard probe ceiling, and a caller-supplied
 * `pace()` awaited between probe batches. Work it does not finish is left for
 * the next pass and REPORTED, never silently dropped.
 */
import { errMsg } from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import { physicalRootKey } from './eviction-domain.js'
import type { RealpathSync } from './eviction-domain.js'
import { locationForHydratedProfile } from './roots.js'
import type { RecordingsLocation } from './roots.js'
import { hourStartMs } from './segment-hour-ledger.js'
import type { SegmentHourRow } from './segment-hour-ledger.js'
import { parseSegmentPath } from '../segment-path.js'
import type { SegmentRow } from '../types.js'

const HOUR_MS = 3_600_000

/**
 * Ghost hour rows examined per pass.
 *
 * The live backlog is 32 rows, so two daily passes clear it. The bound exists
 * because the cost of a pass is directory listings on the array every live read
 * is already competing for — a pass that decided to clear a thousand-row
 * backlog in one go would be an outage, not a cleanup.
 */
export const GHOST_MAX_HOURS_PER_PASS = 16

/**
 * Hard ceiling on hour-directory listings per pass.
 *
 * Since D523 the probe unit is the DIRECTORY, not the path: one hour costs one
 * listing per distinct physical root — two or three on this hub — where it used
 * to cost up to ~1 000 `storage.exists` calls. The ceiling is kept because the
 * bound is the point and not its size: the hour that would cross it is left
 * UNDECIDED and counted, because a half-probed hour must never be forgotten.
 */
export const GHOST_MAX_PROBES_PER_PASS = 4_000

/** Listings between `pace()` awaits, counted across the whole PASS. Per hour it
 *  would never be reached: an hour costs one listing per physical root. */
export const GHOST_PROBE_BATCH = 16

/**
 * Why one ghost hour was left standing. Every one of these is a REFUSAL, and
 * every one is counted in the pass summary — a pass that skipped everything and
 * a pass with nothing to do must never read the same.
 */
export type GhostSkipReason =
  /** Newer than the live-tail cutoff: a writer could still be finalizing into it. */
  | 'live-tail'
  /** A candidate root could not say what its copy of the hour holds. Its
   *  emptiness is UNREAD, not real. */
  | 'detail-unavailable'
  /** The row accounts for no segments at all — nothing to confirm. */
  | 'no-paths'
  /** A name in the found listing did not parse, or did not belong to the hour
   *  it is filed under. */
  | 'unparseable-paths'
  /** A probe threw. An I/O error is not evidence of absence (D49). */
  | 'probe-error'
  /** The file is on more than one physical root. Repointing would be a guess. */
  | 'found-at-multiple-roots'
  /** The ledger refused the durable write; nothing was changed. */
  | 'durable-refused'
  /** The pass ran out of its probe budget mid-hour. */
  | 'probe-budget'

/** Why a whole pass did nothing at all. */
export type GhostPassRefusal =
  /** `storage.listLocations` resolved nothing — every id looks like a ghost. */
  'no-resolvable-location'

/** One physical root a ghost path may be probed against, with its aliases. */
export interface GhostProbeRoot {
  /** `physicalRootKey` of the root — symlinked aliases collapse to one entry. */
  readonly key: string
  /** Every resolved location reaching this root, for per-profile attribution. */
  readonly aliases: readonly RecordingsLocation[]
}

/** What one pass examined, changed and refused. */
export interface GhostSweepResult {
  /** The unresolvable location ids the ledger currently holds rows for. */
  readonly ghostLocations: readonly string[]
  /** Ghost hour rows the ledger holds, across every ghost location. */
  readonly ghostHours: number
  readonly hoursExamined: number
  readonly hoursRepointed: number
  readonly hoursForgotten: number
  readonly segmentsRepointed: number
  readonly segmentsForgotten: number
  readonly bytesForgotten: number
  readonly hoursSkipped: number
  readonly skippedByReason: Readonly<Record<GhostSkipReason, number>>
  readonly probes: number
  /** Ghost hours this pass did not reach. The next pass takes them. */
  readonly hoursDeferred: number
  readonly refused: GhostPassRefusal | null
}

/**
 * The ledger surface this pass needs, structurally — so a test can hand it a
 * ledger that REFUSES and pin that nothing was forgotten.
 */
export interface GhostLedger {
  /** Every hour row held. Pure RAM: no query per pass. */
  readonly snapshot: () => readonly SegmentHourRow[]
  /** Is this hour row still held? Read back after a forget rather than assumed. */
  readonly knowsHour: (
    deviceId: number,
    profile: string,
    locationId: string,
    hour: number,
  ) => boolean
  /** Forget one ghost hour row outright — every candidate root listed it EMPTY. */
  readonly forgetHour: (
    deviceId: number,
    profile: string,
    locationId: string,
    hour: number,
  ) => Promise<number>
  /** Write the target hour row, then shrink the source (D291's ordering). */
  readonly repointSegments: (rows: readonly SegmentRow[], toLocationId: string) => Promise<void>
}

export interface GhostLocationSweepDeps {
  readonly ledger: GhostLedger
  /** Currently resolvable recordings locations. Empty ⇒ the pass refuses. */
  readonly locations: () => readonly RecordingsLocation[]
  /**
   * What does `locationId`'s copy of this hour DIRECTORY hold?
   *
   * `null` and a THROW are both "nothing decided" and both matter: the caller
   * turns either into a refusal, never into "absent". An empty array is the
   * only thing that means absent, and the lister owes the caller a reason to
   * believe it — on this hub, a read of the location ROOT (D523).
   */
  readonly listHour: (
    locationId: string,
    deviceId: number,
    profile: string,
    hourStartMs: number,
  ) => Promise<readonly string[] | null>
  /**
   * Re-point these rows in the RESIDENT index, AFTER the durable write landed.
   * Kept separate from the ledger writes so the ordering — durable first, RAM
   * untouched on a refusal — is a property a test can assert rather than an
   * implementation detail of a wiring closure.
   */
  readonly applyToIndex: (rows: readonly SegmentRow[], toLocationId: string) => void
  /**
   * Drop every resident index row for one (device, ghost location, hour), AFTER
   * the durable forget landed; answers the paths it dropped.
   *
   * It takes the TRIPLE and not a path list because the ghost row names no file
   * (D523) — the index is the only party that still knows which paths it was
   * holding under an id nothing resolves, so it is asked to empty the hour
   * rather than told which rows to remove.
   */
  readonly forgetInIndex: (
    deviceId: number,
    locationId: string,
    hourStartMs: number,
  ) => readonly string[]
  readonly logger: Pick<IScopedLogger, 'info' | 'warn' | 'debug'>
  readonly now: () => number
  /** Awaited every {@link GHOST_PROBE_BATCH} probes. The janitor's brake. */
  readonly pace: () => Promise<void>
  readonly realpath?: RealpathSync
  readonly maxHoursPerPass?: number
  readonly maxProbesPerPass?: number
}

/**
 * Group resolved locations by PHYSICAL root, so two aliases of one disk are
 * probed once and a `true` from each is not mistaken for the file existing in
 * two places.
 *
 * Ordered by key for determinism: which root a mis-pointed hour lands on must
 * not depend on `listLocations` ordering.
 */
export function ghostProbeRoots(
  locations: readonly RecordingsLocation[],
  realpath?: RealpathSync,
): readonly GhostProbeRoot[] {
  const byKey = new Map<string, RecordingsLocation[]>()
  for (const location of locations) {
    const key =
      realpath === undefined
        ? physicalRootKey(location.root)
        : physicalRootKey(location.root, realpath)
    const held = byKey.get(key)
    if (held) held.push(location)
    else byKey.set(key, [location])
  }
  return [...byKey.entries()]
    .map(([key, aliases]) => ({ key, aliases }))
    .toSorted((a, b) => a.key.localeCompare(b.key))
}

/** The per-hour verdict a probe run produces. */
type HourVerdict =
  | {
      readonly kind: 'found'
      readonly root: GhostProbeRoot
      /** What that root's copy of the hour actually holds. */
      readonly paths: readonly string[]
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'refused'; readonly reason: GhostSkipReason; readonly detail: string }

/** Per-device tallies, so the summary names cameras instead of rows. */
interface DeviceTally {
  repointedHours: number
  repointedSegments: number
  forgottenHours: number
  forgottenSegments: number
  forgottenBytes: number
  skipped: number
  probes: number
  readonly targets: Set<string>
  readonly reasons: Set<GhostSkipReason>
}

function emptyTally(): DeviceTally {
  return {
    repointedHours: 0,
    repointedSegments: 0,
    forgottenHours: 0,
    forgottenSegments: 0,
    forgottenBytes: 0,
    skipped: 0,
    probes: 0,
    targets: new Set<string>(),
    reasons: new Set<GhostSkipReason>(),
  }
}

/** Every reason at zero — so a reason that never fired is REPORTED as zero
 *  rather than absent, and the summary shape does not change between passes. */
function zeroReasons(): Record<GhostSkipReason, number> {
  return {
    'live-tail': 0,
    'detail-unavailable': 0,
    'no-paths': 0,
    'unparseable-paths': 0,
    'probe-error': 0,
    'found-at-multiple-roots': 0,
    'durable-refused': 0,
    'probe-budget': 0,
  }
}

/**
 * One reconcile pass over the ledger's ghost-location hour rows.
 *
 * Single-flighted by its caller ({@link startPeriodicPass}). Never throws: a
 * per-hour failure is a refusal with a reason, and the pass continues.
 */
export class GhostLocationSweeper {
  constructor(private readonly deps: GhostLocationSweepDeps) {}

  async sweep(): Promise<GhostSweepResult> {
    const maxHours = this.deps.maxHoursPerPass ?? GHOST_MAX_HOURS_PER_PASS
    const maxProbes = this.deps.maxProbesPerPass ?? GHOST_MAX_PROBES_PER_PASS
    const skippedByReason = zeroReasons()
    const byDevice = new Map<number, DeviceTally>()

    const locations = this.deps.locations()
    const roots = ghostProbeRoots(locations, this.deps.realpath)
    if (roots.length === 0) {
      // Every id in the ledger looks unresolvable when NOTHING resolves. A pass
      // that proceeded here would propose forgetting the entire archive.
      this.deps.logger.warn(
        'recorder: ghost-location reconcile did NOTHING — no recordings location resolves, so every ledger row looks like a ghost and none of them can be confirmed',
        { meta: { heldHours: this.deps.ledger.snapshot().length } },
      )
      return {
        ghostLocations: [],
        ghostHours: 0,
        hoursExamined: 0,
        hoursRepointed: 0,
        hoursForgotten: 0,
        segmentsRepointed: 0,
        segmentsForgotten: 0,
        bytesForgotten: 0,
        hoursSkipped: 0,
        skippedByReason,
        probes: 0,
        hoursDeferred: 0,
        refused: 'no-resolvable-location',
      }
    }

    const resolvable = new Set(locations.map((l) => l.id))
    const ghosts = this.deps.ledger
      .snapshot()
      .filter((row) => !resolvable.has(row.locationId))
      .toSorted((a, b) => a.hourStartMs - b.hourStartMs || a.key.localeCompare(b.key))
    const ghostLocations = [...new Set(ghosts.map((row) => row.locationId))].toSorted()

    if (ghosts.length === 0) {
      this.deps.logger.debug('recorder: ghost-location reconcile — nothing to reconcile', {
        meta: { locations: [...resolvable].toSorted(), roots: roots.length },
      })
      return {
        ghostLocations,
        ghostHours: 0,
        hoursExamined: 0,
        hoursRepointed: 0,
        hoursForgotten: 0,
        segmentsRepointed: 0,
        segmentsForgotten: 0,
        bytesForgotten: 0,
        hoursSkipped: 0,
        skippedByReason,
        probes: 0,
        hoursDeferred: 0,
        refused: null,
      }
    }

    // A writer could still be finalizing into the newest hour. Nothing WRITES
    // to an unresolvable location, so this can only matter in the seconds after
    // a location record disappears — which is exactly when the reconcile must
    // not race the finalize that is still landing paths in that row.
    const liveTailFrom = this.deps.now() - HOUR_MS

    let examined = 0
    let probes = 0
    let repointedHours = 0
    let forgottenHours = 0
    let segmentsRepointed = 0
    let segmentsForgotten = 0
    let bytesForgotten = 0
    let skipped = 0

    const tallyOf = (deviceId: number): DeviceTally => {
      const held = byDevice.get(deviceId)
      if (held) return held
      const fresh = emptyTally()
      byDevice.set(deviceId, fresh)
      return fresh
    }
    const refuse = (row: SegmentHourRow, reason: GhostSkipReason, detail: string): void => {
      skipped += 1
      skippedByReason[reason] += 1
      const tally = tallyOf(row.deviceId)
      tally.skipped += 1
      tally.reasons.add(reason)
      this.deps.logger.debug('recorder: ghost hour left standing', {
        tags: { deviceId: row.deviceId },
        meta: { key: row.key, reason, detail },
      })
    }

    for (const row of ghosts) {
      if (examined >= maxHours || probes >= maxProbes) break
      examined += 1

      if (row.hourStartMs >= liveTailFrom) {
        refuse(row, 'live-tail', `hourStartMs=${row.hourStartMs}`)
        continue
      }

      if (row.segments === 0) {
        refuse(row, 'no-paths', 'the row accounts for no segments')
        continue
      }

      const before = probes
      const verdict = await this.probeHour(row, roots, maxProbes - probes, probes)
      probes += verdict.probes
      tallyOf(row.deviceId).probes += probes - before

      if (verdict.outcome.kind === 'refused') {
        refuse(row, verdict.outcome.reason, verdict.outcome.detail)
        continue
      }

      if (verdict.outcome.kind === 'found') {
        const target = locationForHydratedProfile(verdict.outcome.root.aliases, row.profile)
        const rows = this.rowsOf(row, verdict.outcome.paths)
        if (rows === null) {
          refuse(row, 'unparseable-paths', 'a listed name does not parse into this hour')
          continue
        }
        // NOT orphaned — mis-pointed. Repoint; deleting here would destroy the
        // index of footage that exists (D291). What moves is what the found
        // directory actually HOLDS, never what the ghost row said it held: the
        // listing is the authority for which segments exist (D523).
        await this.deps.ledger.repointSegments(rows, target.id)
        this.deps.applyToIndex(rows, target.id)
        repointedHours += 1
        segmentsRepointed += rows.length
        const tally = tallyOf(row.deviceId)
        tally.repointedHours += 1
        tally.repointedSegments += rows.length
        tally.targets.add(target.id)
        continue
      }

      // Every candidate root listed this hour and every one of them came back
      // EMPTY. That is the trusted walk D148 asks for, done once per root.
      const forgotten = await this.deps.ledger.forgetHour(
        row.deviceId,
        row.profile,
        row.locationId,
        row.hourStartMs,
      )
      if (this.deps.ledger.knowsHour(row.deviceId, row.profile, row.locationId, row.hourStartMs)) {
        refuse(row, 'durable-refused', 'the ledger still holds the hour after the forget')
        continue
      }
      this.deps.forgetInIndex(row.deviceId, row.locationId, row.hourStartMs)
      forgottenHours += 1
      segmentsForgotten += forgotten
      bytesForgotten += row.bytes
      const tally = tallyOf(row.deviceId)
      tally.forgottenHours += 1
      tally.forgottenSegments += forgotten
      tally.forgottenBytes += row.bytes
    }

    for (const [deviceId, tally] of byDevice) {
      this.deps.logger.info('recorder: ghost-location reconcile — camera summary', {
        tags: { deviceId },
        meta: {
          repointedHours: tally.repointedHours,
          repointedSegments: tally.repointedSegments,
          repointedTo: [...tally.targets].toSorted(),
          forgottenHours: tally.forgottenHours,
          forgottenSegments: tally.forgottenSegments,
          forgottenBytes: tally.forgottenBytes,
          skippedHours: tally.skipped,
          skipReasons: [...tally.reasons].toSorted(),
          probes: tally.probes,
        },
      })
    }

    const deferred = ghosts.length - examined
    const result: GhostSweepResult = {
      ghostLocations,
      ghostHours: ghosts.length,
      hoursExamined: examined,
      hoursRepointed: repointedHours,
      hoursForgotten: forgottenHours,
      segmentsRepointed,
      segmentsForgotten,
      bytesForgotten,
      hoursSkipped: skipped,
      skippedByReason,
      probes,
      hoursDeferred: deferred,
      refused: null,
    }
    this.deps.logger.info('recorder: ghost-location reconcile complete', {
      meta: {
        ghostLocations,
        ghostHours: result.ghostHours,
        examined,
        repointedHours,
        repointedSegments: segmentsRepointed,
        forgottenHours,
        forgottenSegments: segmentsForgotten,
        forgottenBytes: bytesForgotten,
        skippedHours: skipped,
        skippedByReason,
        probes,
        deferredHours: deferred,
        roots: roots.length,
      },
    })
    return result
  }

  /**
   * The hour row's paths as {@link SegmentRow}s.
   *
   * The tuple fields come from the LEDGER ROW, not the path: `dropSegments` and
   * `repointSegments` bucket by `(deviceId, profile, locationId, hour)`, and a
   * row rebuilt with a profile the filename spells differently would compute a
   * different key — the write would then silently no-op while this pass counted
   * it as done. Only `startMs` / `durMs` / `bytes` come from the filename,
   * which is where they are recorded.
   *
   * `null` when ANY path fails to parse or lands outside the hour it is filed
   * under. Acting on a partially-understood hour is how a forget takes a path
   * nobody confirmed.
   */
  private rowsOf(row: SegmentHourRow, paths: readonly string[]): readonly SegmentRow[] | null {
    const out: SegmentRow[] = []
    for (const path of paths) {
      const parsed = parseSegmentPath(path)
      if (parsed === null) return null
      if (hourStartMs(parsed.startMs) !== row.hourStartMs) return null
      out.push({
        deviceId: row.deviceId,
        profile: row.profile,
        locationId: row.locationId,
        startMs: parsed.startMs,
        durMs: parsed.durMs,
        bytes: parsed.bytes,
        path,
      })
    }
    return out
  }

  /**
   * List this hour's directory under EVERY candidate root.
   *
   * A non-empty listing at one root makes the hour mis-pointed. Two roots
   * holding it is a refusal, not a choice: repointing would be a guess about
   * which copy is the footage. Absence is only concluded when every root
   * answered and every answer was empty — a listing that could not decide
   * (`null`) or threw ends the hour with nothing decided (D49).
   *
   * The whole loop runs even after a hit, because "found at exactly one root"
   * is a claim about every root and cannot be short-circuited without giving up
   * the multi-root refusal.
   *
   * `spent` is the listings the PASS has already made, not this hour's, and the
   * brake fires on that running total. Since D523 an hour costs one listing per
   * physical root — two or three on this hub — so a counter that reset per hour
   * would never reach {@link GHOST_PROBE_BATCH} and the `pace()` dep would be
   * dead on every real topology.
   */
  private async probeHour(
    row: SegmentHourRow,
    roots: readonly GhostProbeRoot[],
    budget: number,
    spent: number,
  ): Promise<{ readonly outcome: HourVerdict; readonly probes: number }> {
    let used = 0
    const found: { readonly root: GhostProbeRoot; readonly paths: readonly string[] }[] = []
    for (const root of roots) {
      if (used >= budget) {
        return {
          outcome: {
            kind: 'refused',
            reason: 'probe-budget',
            detail: `stopped after ${used} listings with ${roots.length} roots to probe`,
          },
          probes: used,
        }
      }
      const alias = locationForHydratedProfile(root.aliases, row.profile)
      used += 1
      if ((spent + used) % GHOST_PROBE_BATCH === 0) await this.deps.pace()
      let listing: readonly string[] | null
      try {
        listing = await this.deps.listHour(alias.id, row.deviceId, row.profile, row.hourStartMs)
      } catch (err: unknown) {
        return {
          outcome: {
            kind: 'refused',
            reason: 'probe-error',
            detail: `${alias.id}: ${errMsg(err)}`,
          },
          probes: used,
        }
      }
      if (listing === null) {
        return {
          outcome: {
            kind: 'refused',
            reason: 'detail-unavailable',
            detail: `${alias.id} could not say what its copy of this hour holds`,
          },
          probes: used,
        }
      }
      if (listing.length > 0) found.push({ root, paths: listing })
    }
    if (found.length > 1) {
      return {
        outcome: {
          kind: 'refused',
          reason: 'found-at-multiple-roots',
          detail: found.map((hit) => hit.root.key).join(', '),
        },
        probes: used,
      }
    }
    const only = found[0]
    if (only !== undefined) {
      return { outcome: { kind: 'found', root: only.root, paths: only.paths }, probes: used }
    }
    return { outcome: { kind: 'absent' }, probes: used }
  }
}
