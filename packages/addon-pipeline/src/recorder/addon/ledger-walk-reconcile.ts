/**
 * The ledger↔disk reconcile: **one `readdir` per accounted HOUR**, against what
 * that hour's durable row says it holds.
 *
 * ## What it answers
 *
 * "Does my ledger tell the truth?" — the question an operator had no tool for.
 * The 11 074 ghost rows / 5 650 495 197 B on `recordingsLow:default` were found
 * only as a side effect of a drain that walked to each of them one `stat` at a
 * time and logged 11 074 warnings (D318). This asks the same question directly,
 * in both directions, and by default answers it without changing anything.
 *
 * ## What it compares, since D523
 *
 * Counts and bytes, not names. The row accounts for HOW MUCH an hour holds and
 * names no file, so "which segment is missing" is not a question anything can
 * ask of it — and it does not need to be asked: the repair is
 * `adoptWalkedHour`, which makes the account exactly the listing's, and the
 * resident index is reset to that same listing so an index row naming a file the
 * directory does not hold goes with it. The hour whose directory holds NOTHING
 * is the one case a listing cannot re-derive from, and it is the one case that
 * forgets the row outright — under the anchor re-read below.
 *
 * ## Why a walk, and why it needs no budget
 *
 * D148 names two evidence classes that may make the ledger forget: a **trusted
 * walk**, or an **eviction**. D318's `max(64, 25 %)` budget exists because a
 * mover's ENOENT is *per-path* evidence — strong about one file, weak about a
 * MOUNT: a root that has gone away answers ENOENT for everything, and without
 * the bound one bad mount would let the system erase its own index.
 *
 * A directory listing is the strong evidence D148 already sanctions, and it is
 * *complete*: the hour's whole truth in one syscall, so the "did I ask about
 * every path" question a per-path sweep must answer with a probe ceiling
 * (D296) is answered by construction. Under a walk the budget is unnecessary
 * machinery, not a safety net — so there is none here.
 *
 * That licence is bought with two preconditions this module REFUSES without,
 * because both are what make a listing strong:
 *
 * 1. **The source must not be writable.** A walk of a live location races the
 *    writes it is diffing, and `readdir` cannot tell "this hour is short" from
 *    "this hour is being written" — which is the exact strength the licence
 *    rests on. The remedy is one flag (`readOnly`), the same flag a drain sets.
 *    The live case already has a mechanism with a bound: D318's mover. A second,
 *    weaker copy of it here would be the redundancy this pass exists to remove.
 * 2. **The volume must still be the one the pass started on.** A missing hour
 *    DIRECTORY is the strongest ghost evidence there is and the exact signature
 *    of a vanished mount — on 2026-08-29 the USB disk was unplugged and
 *    re-plugged onto another port at 12:44 and the container wrote against a
 *    filesystem that was no longer there. The discriminator is the volume
 *    marker `PlacementService` already writes at the root
 *    (`.camstack-location`): it lives on the DISK, so a mount that went away
 *    takes it with it while leaving the mountpoint directory readable. The
 *    anchor is read before the pass and again before every hour that would
 *    forget anything — the "second read to agree in the destroying direction"
 *    (D49) — and a marker that is absent, unreadable or CHANGED stops the pass
 *    with nothing further forgotten.
 *
 * ## What it costs
 *
 * One `readdir` per claimed hour, plus one small marker read per hour that
 * would forget, plus one durable point read per hour it forgot (the read-back).
 * On the live shape — 63 346 claimed rows on `recordingsLow:default`, of which
 * 11 074 ghosts in 55 whole (device, hour) groups — that is ≈181 listings and
 * ≈55 anchor reads, against the 11 074 `stat`s the mover pays to discover the
 * same absences one at a time. It is also the only thing here that can see the
 * OTHER direction: files on disk the ledger does not claim.
 *
 * ## What it deliberately does not do
 *
 * **It does not fix sizes.** `readdir` returns names; the recorded byte count
 * IS the name (`segmentRelPath`), so a file that disagrees with its own name is
 * invisible here (D307). Learning the real size means one `stat` per file —
 * 11 074 syscalls to re-answer what one `readdir` already answered — which is
 * exactly the cost this pass was chosen to avoid, and strictly worse than
 * D307's mover, which already holds the source `stat` because it must read the
 * file anyway. So sizes stay D307's, and a rename stays the only thing that
 * fixes one.
 *
 * **It never deletes a file.** An hour holding more than its row accounts for is
 * REPORTED, with a bounded sample, and left exactly where it is.
 */

import type {
  IScopedLogger,
  LedgerWalkDeviceReport,
  LedgerWalkRefusal,
  LedgerWalkReport,
  LedgerWalkSkipCounts,
  LedgerWalkSkipReason,
} from '@camstack/types'
import { errMsg } from '@camstack/types'
import { parseSegmentPath } from '../segment-path.js'
import type { ArchiveScope, FootageArchive } from '../types.js'
import type { RecordingsLocation } from './roots.js'
import { hourDirRelPath, locationMayBeWritten } from './roots.js'
import type { SegmentHourRow, WalkedHourOutcome } from './segment-hour-ledger.js'
import { hourAggregate, hourStartMs } from './segment-hour-ledger.js'

const HOUR_MS = 3_600_000

/**
 * Claimed hours one pass will walk.
 *
 * Not a safety bound — the walk needs none — but a liveness one: a pass must be
 * interruptible and must not hold the runner for an unbounded time on a
 * saturated array. Work it does not reach is REPORTED (`bounded`) and taken by
 * the next run, which is free because the pass re-derives its claim set from
 * the ledger every time and a forgotten hour is no longer claimed.
 *
 * 4 096 hours ≈ 1.4 M segments at 350/hour — an order past the live
 * `recordingsLow:default` (≈181 hours) and still finite.
 */
export const WALK_MAX_HOURS_PER_PASS = 4_096

/**
 * Hour listings between `pace()` awaits — the janitor's brake.
 *
 * The `~650 ms per hour readdir` this used to cite was measured on the FUSE
 * share (`shfs`) that has since been retired; on the SATA SSD serving
 * `/recordings-2` an hour directory of 345–349 files lists in ~1 ms (D523). The
 * brake is kept anyway, and the number is not the reason: contention is. A
 * `find` over this array hung an SSH session on 2026-08-29, and this pass runs
 * against the same disk every live read is competing for.
 */
export const WALK_HOUR_BATCH = 8

/** Orphan paths carried back to the operator. A sample is a lead; the full set
 *  would be the archive-sized response this whole tier exists without (D287). */
export const WALK_ORPHAN_SAMPLE = 50

/**
 * Hours at the head of the archive this pass will not touch.
 *
 * A non-writable location has no writer, so this can only matter in the seconds
 * after an operator freezes one — which is exactly when a finalize may still be
 * landing a path in the newest row. Two hours costs two hour rows.
 */
export const WALK_LIVE_TAIL_HOURS = 2

/**
 * The report, the refusals and the per-camera rows are `z.infer` of the
 * schemas in `@camstack/types` — one shape, so the wire form and this module
 * can never drift. Re-exported here because this is where they are produced.
 */
export type {
  LedgerWalkDeviceReport,
  LedgerWalkRefusal,
  LedgerWalkReport,
  LedgerWalkSkipCounts,
  LedgerWalkSkipReason,
}

/**
 * The ledger this pass reads and writes, structurally — so a test can hand it
 * one that REFUSES and pin that nothing was counted as forgotten.
 *
 * The archive half and the durable half are ONE surface because they are one
 * object in production (`SegmentHourLedger`), and splitting them here would
 * invite a pass that streamed from a live archive and forgot against a stale
 * durable handle.
 */
export interface LedgerWalkLedger extends FootageArchive {
  /** Every hour row held. Pure RAM — this pass derives its claim set from the
   *  mirror, never from a query, because it MUTATES what it walks. */
  readonly snapshot: () => readonly SegmentHourRow[]
  /** Make a CLOSED hour's account exactly what the listing holds, and seal it. */
  readonly adoptWalkedHour: (
    deviceId: number,
    profile: string,
    locationId: string,
    hour: number,
    paths: readonly string[],
  ) => Promise<WalkedHourOutcome | null>
  /** Forget one hour row outright — for a directory this pass CONFIRMED holds
   *  nothing, the one case a listing cannot re-derive an account from. Answers
   *  the segments the row had accounted for. */
  readonly forgetHour: (
    deviceId: number,
    profile: string,
    locationId: string,
    hour: number,
  ) => Promise<number>
  /** Is this hour row still held? Pure RAM — the read-back's cheap half. */
  readonly knowsHour: (
    deviceId: number,
    profile: string,
    locationId: string,
    hour: number,
  ) => boolean
  /** One held hour row. Pure RAM. */
  readonly hourRow: (
    deviceId: number,
    profile: string,
    locationId: string,
    hour: number,
  ) => SegmentHourRow | undefined
}

export interface LedgerWalkReconcileDeps {
  /**
   * The durable hour ledger — the ARCHIVE, paged (D295), never the resident
   * index. Read per call, not captured: it is `null` until the collection
   * declares, and a pass that closed over that null would refuse forever.
   */
  readonly ledger: () => LedgerWalkLedger | null
  readonly locations: () => readonly RecordingsLocation[]
  /**
   * The names in ONE hour directory.
   *
   * `null` means the directory is not there — data, not a failure. Anything
   * else THROWS, and a throw decides nothing (D49).
   */
  readonly listHour: (root: string, relDir: string) => Promise<readonly string[] | null>
  /**
   * The volume id claimed by the marker at `root`; `null` when there is no
   * marker. THROWS when the root could not be read at all.
   *
   * This is the ONE thing in the recorder that can tell "the disk is mounted"
   * from "the mountpoint directory exists" (`placement-volume.ts`), which is
   * the only honest way to tell a missing hour from a missing mount.
   */
  readonly anchorOf: (root: string) => Promise<string | null>
  /**
   * Make the RESIDENT index's view of one hour exactly the listing, AFTER the
   * durable write landed. Answers the paths it dropped — index rows naming a
   * file this walk proved the directory does not hold.
   */
  readonly applyToIndex: (
    deviceId: number,
    locationId: string,
    hour: number,
    paths: readonly string[],
  ) => readonly string[]
  readonly logger: Pick<IScopedLogger, 'info' | 'warn' | 'debug'>
  readonly now: () => number
  /** Awaited every {@link WALK_HOUR_BATCH} listings. */
  readonly pace: () => Promise<void>
  readonly maxHours?: number
}

export interface LedgerWalkRequest {
  readonly locationId: string
  /**
   * Forget the ghosts, rather than only counting them.
   *
   * Defaults to `false`, and that default is the point: the operator's missing
   * tool is the QUESTION, and a dry run is how they sanity-check the
   * destructive run before authorising it.
   */
  readonly apply?: boolean
  readonly deviceId?: number
  readonly profiles?: readonly string[]
}

/** Every reason at zero, so a reason that never fired reports as zero rather
 *  than absent and the summary shape is constant between passes. */
function zeroReasons(): LedgerWalkSkipCounts {
  return { 'live-tail': 0, 'listing-error': 0, 'path-mismatch': 0, 'durable-refused': 0 }
}

/** Mutable per-camera tallies. */
interface DeviceTally {
  hoursWalked: number
  hoursMissing: number
  ghostSegments: number
  ghostBytes: number
  forgottenSegments: number
  orphanFiles: number
}

function emptyTally(): DeviceTally {
  return {
    hoursWalked: 0,
    hoursMissing: 0,
    ghostSegments: 0,
    ghostBytes: 0,
    forgottenSegments: 0,
    orphanFiles: 0,
  }
}

/** Does this hour row fall inside the scope the operator asked for? */
function inScope(row: SegmentHourRow, scope: ArchiveScope): boolean {
  if (scope.locationId !== undefined && row.locationId !== scope.locationId) return false
  if (scope.deviceId !== undefined && row.deviceId !== scope.deviceId) return false
  const profiles = scope.profiles ?? []
  return profiles.length === 0 || profiles.includes(row.profile)
}

/** The pass's running state, so the walk loop reads as the decision it is. */
interface WalkState {
  readonly location: RecordingsLocation
  readonly ledger: LedgerWalkLedger
  readonly apply: boolean
  readonly anchor: string
  readonly liveTailFrom: number
  readonly maxHours: number
  readonly byDevice: Map<number, DeviceTally>
  readonly skippedByReason: LedgerWalkSkipCounts
  readonly orphanSample: string[]
  hoursClaimed: number
  hoursWalked: number
  hoursMissing: number
  listings: number
  segmentsClaimed: number
  ghostSegments: number
  ghostBytes: number
  ghostHoursWhole: number
  forgottenSegments: number
  forgottenBytes: number
  orphanFiles: number
  hoursSkipped: number
  bounded: boolean
  refused: LedgerWalkRefusal | null
}

/**
 * The volume anchor read, as a verdict.
 *
 * A discriminated union rather than `string | 'anchor-absent'`: those refusal
 * ids ARE strings, so a `typeof === 'string'` narrowing over them silently
 * treats every refusal as a valid volume id. The first run of this suite caught
 * exactly that.
 */
type AnchorRead =
  | { readonly ok: true; readonly volumeId: string }
  | { readonly ok: false; readonly refusal: 'anchor-absent' | 'anchor-unreadable' }

/**
 * One reconcile pass over one location's claimed hours.
 *
 * Never throws: a per-hour failure is a counted refusal and the pass continues;
 * a precondition failure is a named refusal and the pass does nothing at all.
 */
export class LedgerWalkReconciler {
  constructor(private readonly deps: LedgerWalkReconcileDeps) {}

  async run(request: LedgerWalkRequest): Promise<LedgerWalkReport> {
    const apply = request.apply === true
    const location = this.deps.locations().find((candidate) => candidate.id === request.locationId)
    if (location === undefined)
      return this.refusedReport(request.locationId, apply, 'location-unknown')

    // A location the system may still WRITE to is a location whose listings
    // are a LOWER BOUND, and a lower bound is not the strong evidence this
    // pass's missing budget rests on. One mode change away (D385).
    if (locationMayBeWritten(location)) {
      this.deps.logger.warn(
        'recorder: ledger walk REFUSED — the source is still a write target, so a directory listing is a lower bound, not the truth',
        {
          meta: {
            locationId: location.id,
            root: location.root,
            mode: location.mode,
            remedy:
              'switch the location to readonly / drain / disabled and re-run; a LIVE location is reconciled by the mover, under its bound',
          },
        },
      )
      return this.refusedReport(location.id, apply, 'source-writable')
    }

    const ledger = this.deps.ledger()
    if (ledger === null) {
      this.deps.logger.warn(
        'recorder: ledger walk REFUSED — this node holds no durable hour ledger, so there is no archive to reconcile',
        { meta: { locationId: location.id } },
      )
      return this.refusedReport(location.id, apply, 'no-ledger')
    }

    const anchor = await this.readAnchor(location)
    if (!anchor.ok) return this.refusedReport(location.id, apply, anchor.refusal)

    const scope: ArchiveScope = {
      locationId: location.id,
      ...(request.deviceId !== undefined ? { deviceId: request.deviceId } : {}),
      ...(request.profiles !== undefined && request.profiles.length > 0
        ? { profiles: request.profiles }
        : {}),
    }
    const census = await ledger.census(scope)
    if (census === null) {
      this.deps.logger.warn(
        'recorder: ledger walk REFUSED — the archive could not say what this location holds, so no walk of it can be reported against anything',
        { meta: { locationId: location.id } },
      )
      return this.refusedReport(location.id, apply, 'archive-unreadable')
    }

    const state: WalkState = {
      location,
      ledger,
      apply,
      anchor: anchor.volumeId,
      liveTailFrom: hourStartMs(this.deps.now()) - (WALK_LIVE_TAIL_HOURS - 1) * HOUR_MS,
      maxHours: this.deps.maxHours ?? WALK_MAX_HOURS_PER_PASS,
      byDevice: new Map<number, DeviceTally>(),
      skippedByReason: zeroReasons(),
      orphanSample: [],
      hoursClaimed: 0,
      hoursWalked: 0,
      hoursMissing: 0,
      listings: 0,
      segmentsClaimed: 0,
      ghostSegments: 0,
      ghostBytes: 0,
      ghostHoursWhole: 0,
      forgottenSegments: 0,
      forgottenBytes: 0,
      orphanFiles: 0,
      hoursSkipped: 0,
      bounded: false,
      refused: null,
    }

    await this.walk(state, scope)

    const report: LedgerWalkReport = {
      locationId: location.id,
      applied: apply,
      refused: state.refused,
      archiveSegments: census.segments,
      archiveBytes: census.bytes,
      hoursClaimed: state.hoursClaimed,
      hoursWalked: state.hoursWalked,
      hoursMissing: state.hoursMissing,
      listings: state.listings,
      segmentsClaimed: state.segmentsClaimed,
      ghostSegments: state.ghostSegments,
      ghostBytes: state.ghostBytes,
      ghostHoursWhole: state.ghostHoursWhole,
      forgottenSegments: state.forgottenSegments,
      forgottenBytes: state.forgottenBytes,
      orphanFiles: state.orphanFiles,
      orphanSample: [...state.orphanSample],
      hoursSkipped: state.hoursSkipped,
      skippedByReason: { ...state.skippedByReason },
      bounded: state.bounded,
      byDevice: [...state.byDevice.entries()]
        .map(([deviceId, tally]) => ({ deviceId, ...tally }))
        .toSorted((a, b) => a.deviceId - b.deviceId),
    }
    this.reportPass(report)
    return report
  }

  /**
   * Walk the hour ROWS of the scope, oldest first.
   *
   * From the MIRROR, not a query. Since D523 a row is ten scalars, so the whole
   * claim set is already in RAM and costs nothing to fold — and the pass mutates
   * what it walks, which is exactly the shape that makes `offset` paging skip
   * half a scope. A snapshot taken once cannot skip.
   */
  private async walk(state: WalkState, scope: ArchiveScope): Promise<void> {
    const claims = state.ledger
      .snapshot()
      .filter((row) => inScope(row, scope))
      .toSorted((a, b) => a.hourStartMs - b.hourStartMs || a.deviceId - b.deviceId)
    for (const claim of claims) {
      if (state.hoursClaimed >= state.maxHours) {
        state.bounded = true
        return
      }
      state.hoursClaimed += 1
      state.segmentsClaimed += claim.segments
      if (!(await this.reconcileHour(state, claim))) return
    }
  }

  /**
   * Reconcile ONE hour: what its row ACCOUNTS FOR against what its directory
   * HOLDS, and repair the account from the directory.
   *
   * Since D523 the row names no files, so this is a comparison of counts and
   * bytes — and it does not need to name them: the repair is "make the account
   * the listing's", which is exact, and the RESIDENT index is reset to the same
   * listing so a row it holds for a file the directory does not is dropped with
   * it.
   *
   * `false` ends the whole pass — the only thing that returns it is an anchor
   * that stopped agreeing, and every listing taken after that point is about a
   * filesystem this pass did not start on.
   */
  private async reconcileHour(state: WalkState, claim: SegmentHourRow): Promise<boolean> {
    const tally = this.tallyOf(state, claim.deviceId)
    if (claim.hourStartMs >= state.liveTailFrom) {
      this.skip(state, claim, 'live-tail', `hourStartMs=${claim.hourStartMs}`)
      return true
    }
    const relDir = hourDirRelPath(claim.deviceId, claim.profile, claim.hourStartMs)

    let listing: readonly string[] | null
    try {
      listing = await this.deps.listHour(state.location.root, relDir)
    } catch (err: unknown) {
      // A listing that FAILED is not a listing that came back empty.
      this.skip(state, claim, 'listing-error', errMsg(err))
      return true
    }
    state.listings += 1
    if (state.listings % WALK_HOUR_BATCH === 0) await this.deps.pace()
    state.hoursWalked += 1
    tally.hoursWalked += 1

    const missingDirectory = listing === null
    if (missingDirectory) {
      state.hoursMissing += 1
      tally.hoursMissing += 1
    }
    // The names a listing returns are bare; the paths every consumer speaks in
    // are location-relative. An entry that does not parse under this hour is not
    // a segment of it and is counted as neither.
    const present: string[] = []
    for (const name of listing ?? []) {
      if (!name.endsWith('.m4s')) continue
      const relPath = `${relDir}/${name}`
      const parsed = parseSegmentPath(relPath)
      if (parsed === null || hourStartMs(parsed.startMs) !== claim.hourStartMs) {
        this.skip(state, claim, 'path-mismatch', relPath)
        return true
      }
      present.push(relPath)
    }
    const listed = hourAggregate(present)

    const orphans = Math.max(0, listed.segments - claim.segments)
    if (orphans > 0) {
      state.orphanFiles += orphans
      tally.orphanFiles += orphans
      for (const path of present) {
        if (state.orphanSample.length >= WALK_ORPHAN_SAMPLE) break
        state.orphanSample.push(path)
      }
      // The hour holds more footage than anything accounted for. It is not dead
      // weight — every reader lists this directory now — but it IS bytes no
      // disk report counted, which is what makes a disk fill up ahead of its
      // own projection. Reported per camera; nothing on disk is ever touched.
      this.deps.logger.warn(
        'recorder: an hour directory holds more segments than its durable row accounts for',
        {
          tags: { deviceId: claim.deviceId },
          meta: {
            locationId: state.location.id,
            profile: claim.profile,
            hourStartMs: claim.hourStartMs,
            accounted: claim.segments,
            listed: listed.segments,
            apply: state.apply,
          },
        },
      )
    }

    const ghosts = Math.max(0, claim.segments - listed.segments)
    if (ghosts === 0) {
      // The counts agree. The account may still be wrong about BYTES — a row
      // shrunk by arithmetic carries extremes nothing re-derived — so a
      // disagreeing hour is still re-derived, and a matching one is left alone.
      if (state.apply && listed.segments > 0 && listed.bytes !== claim.bytes) {
        await state.ledger.adoptWalkedHour(
          claim.deviceId,
          claim.profile,
          state.location.id,
          claim.hourStartMs,
          present,
        )
      }
      if (state.apply) this.resetIndex(state, claim, present)
      return true
    }

    const ghostBytes = Math.max(0, claim.bytes - listed.bytes)
    state.ghostSegments += ghosts
    state.ghostBytes += ghostBytes
    tally.ghostSegments += ghosts
    tally.ghostBytes += ghostBytes
    if (listed.segments === 0) state.ghostHoursWhole += 1

    // The destroying direction gets a SECOND read that has to agree (D49). The
    // marker lives on the disk, so a mount that went away answers `null` here
    // while the mountpoint directory keeps answering ENOENT for every hour —
    // which is precisely what the 2026-08-29 unplug looked like from inside the
    // container.
    const anchor = await this.readAnchor(state.location)
    if (!anchor.ok || anchor.volumeId !== state.anchor) {
      state.refused = anchor.ok ? 'anchor-moved' : anchor.refusal
      this.deps.logger.warn(
        'recorder: ledger walk STOPPED — the volume under this location is not the one the pass started on, so every listing since is about another filesystem and NOTHING more is forgotten',
        {
          tags: { deviceId: claim.deviceId },
          meta: {
            locationId: state.location.id,
            root: state.location.root,
            startedOn: state.anchor,
            foundNow: anchor.ok ? anchor.volumeId : anchor.refusal,
            forgottenBeforeStop: state.forgottenSegments,
          },
        },
      )
      return false
    }

    this.deps.logger.warn(
      'recorder: durable hour row accounts for segments the directory does not hold',
      {
        tags: { deviceId: claim.deviceId },
        meta: {
          locationId: state.location.id,
          profile: claim.profile,
          hourStartMs: claim.hourStartMs,
          accounted: claim.segments,
          listed: listed.segments,
          ghosts,
          ghostBytes,
          wholeHour: listed.segments === 0,
          missingDirectory,
          apply: state.apply,
        },
      },
    )
    if (!state.apply) return true

    // An hour whose directory holds NOTHING is the one case a listing cannot
    // re-derive an account from: `adoptWalkedHour` refuses an empty listing on
    // purpose, because "the walk found nothing" is what an unmounted root looks
    // like. Here it is trusted — the anchor agreed, one line above — so the row
    // goes outright.
    const forgotten =
      listed.segments === 0
        ? await state.ledger.forgetHour(
            claim.deviceId,
            claim.profile,
            state.location.id,
            claim.hourStartMs,
          )
        : await this.adoptLanded(state, claim, present, ghosts)
    if (forgotten === null) {
      this.skip(state, claim, 'durable-refused', 'the ledger still accounts for the ghosts')
      return true
    }
    this.resetIndex(state, claim, present)
    state.forgottenSegments += forgotten
    state.forgottenBytes += ghostBytes
    tally.forgottenSegments += forgotten
    return true
  }

  /**
   * Adopt the listing, then READ THE ROW BACK.
   *
   * `adoptWalkedHour` refuses a listing that would erase more than half of what
   * the row accounts for — the guard against a root that answered short — and it
   * refuses silently, which a caller that counted it as done would turn into
   * telling the resident index a row is gone that the archive still holds.
   * `null` is that refusal.
   */
  private async adoptLanded(
    state: WalkState,
    claim: SegmentHourRow,
    present: readonly string[],
    ghosts: number,
  ): Promise<number | null> {
    await state.ledger.adoptWalkedHour(
      claim.deviceId,
      claim.profile,
      state.location.id,
      claim.hourStartMs,
      present,
    )
    const after = state.ledger.hourRow(
      claim.deviceId,
      claim.profile,
      state.location.id,
      claim.hourStartMs,
    )
    if (after === undefined) return claim.segments
    return after.segments === claim.segments - ghosts ? ghosts : null
  }

  /** Make the resident index's view of the hour the listing's, and say how many
   *  index rows that dropped. */
  private resetIndex(
    state: WalkState,
    claim: SegmentHourRow,
    present: readonly string[],
  ): readonly string[] {
    return this.deps.applyToIndex(claim.deviceId, state.location.id, claim.hourStartMs, present)
  }

  /** The volume anchor, or the refusal its absence produces. */
  private async readAnchor(location: RecordingsLocation): Promise<AnchorRead> {
    let marker: string | null
    try {
      marker = await this.deps.anchorOf(location.root)
    } catch (err: unknown) {
      this.deps.logger.warn(
        'recorder: ledger walk cannot read the volume marker — an unreadable root decides nothing',
        { meta: { locationId: location.id, root: location.root, error: errMsg(err) } },
      )
      return { ok: false, refusal: 'anchor-unreadable' }
    }
    if (marker === null) {
      this.deps.logger.warn(
        'recorder: ledger walk has NO volume marker at this root — a mountpoint directory without its disk answers ENOENT for every hour, which is indistinguishable from an empty location',
        { meta: { locationId: location.id, root: location.root } },
      )
      return { ok: false, refusal: 'anchor-absent' }
    }
    return { ok: true, volumeId: marker }
  }

  private tallyOf(state: WalkState, deviceId: number): DeviceTally {
    const held = state.byDevice.get(deviceId)
    if (held) return held
    const fresh = emptyTally()
    state.byDevice.set(deviceId, fresh)
    return fresh
  }

  private skip(
    state: WalkState,
    claim: SegmentHourRow,
    reason: LedgerWalkSkipReason,
    detail: string,
  ): void {
    state.hoursSkipped += 1
    state.skippedByReason[reason] += 1
    this.deps.logger.debug('recorder: ledger walk left an hour exactly as it found it', {
      tags: { deviceId: claim.deviceId },
      meta: {
        locationId: state.location.id,
        profile: claim.profile,
        hourStartMs: claim.hourStartMs,
        reason,
        detail,
      },
    })
  }

  private refusedReport(
    locationId: string,
    applied: boolean,
    refused: LedgerWalkRefusal,
  ): LedgerWalkReport {
    return {
      locationId,
      applied,
      refused,
      archiveSegments: null,
      archiveBytes: null,
      hoursClaimed: 0,
      hoursWalked: 0,
      hoursMissing: 0,
      listings: 0,
      segmentsClaimed: 0,
      ghostSegments: 0,
      ghostBytes: 0,
      ghostHoursWhole: 0,
      forgottenSegments: 0,
      forgottenBytes: 0,
      orphanFiles: 0,
      orphanSample: [],
      hoursSkipped: 0,
      skippedByReason: zeroReasons(),
      bounded: false,
      byDevice: [],
    }
  }

  /** One line per camera, then one for the pass. */
  private reportPass(report: LedgerWalkReport): void {
    for (const device of report.byDevice) {
      this.deps.logger.info('recorder: ledger walk — camera summary', {
        tags: { deviceId: device.deviceId },
        meta: {
          locationId: report.locationId,
          hoursWalked: device.hoursWalked,
          hoursMissing: device.hoursMissing,
          ghostSegments: device.ghostSegments,
          ghostBytes: device.ghostBytes,
          forgottenSegments: device.forgottenSegments,
          orphanFiles: device.orphanFiles,
        },
      })
    }
    this.deps.logger.info('recorder: ledger walk complete', {
      meta: {
        locationId: report.locationId,
        applied: report.applied,
        refused: report.refused,
        archiveSegments: report.archiveSegments,
        segmentsClaimed: report.segmentsClaimed,
        hoursClaimed: report.hoursClaimed,
        hoursWalked: report.hoursWalked,
        hoursMissing: report.hoursMissing,
        listings: report.listings,
        ghostSegments: report.ghostSegments,
        ghostBytes: report.ghostBytes,
        ghostHoursWhole: report.ghostHoursWhole,
        forgottenSegments: report.forgottenSegments,
        forgottenBytes: report.forgottenBytes,
        orphanFiles: report.orphanFiles,
        hoursSkipped: report.hoursSkipped,
        skippedByReason: report.skippedByReason,
        bounded: report.bounded,
      },
    })
  }
}
