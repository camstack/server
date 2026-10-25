/**
 * The ONE seam that answers "which location does this (camera, profile) write
 * to?" — and the only place that answer is logged, audited and volume-checked.
 *
 * Placement is applied at WRITER-ATTACH BOUNDARIES only (attach, band rollover,
 * give-up recovery). Never mid-run: the `.rec-tmp` staging dir lives UNDER the
 * chosen root precisely so the finalize relocate is a same-filesystem rename,
 * and moving a live writer's target would turn every segment into the EXDEV
 * copy+unlink fallback — 2× disk writes on the hot path (the F1 regression).
 *
 * Four invariants this file exists to hold:
 *
 *   - Every decision LOGS with `tags: { deviceId }`. A placement fault is
 *     always asked per-camera ("why is 102 on the NAS and 101 on the SSD?"),
 *     and a line without the tag cannot answer it.
 *   - An audit row is written only when the assignment CHANGES. A row per
 *     attach would flood the 500-row ops-log ring on every boot (N cameras ×
 *     profiles) and bury the eviction rows that share it.
 *   - A stored assignment is a PLAN, and a plan is valid only against the pool
 *     it was planned for. A REPOINT of a class's authority location invalidates
 *     every assignment of that class that names somewhere else, per camera and
 *     out loud (D298). Before this, `assignedLocation` invalidated only on
 *     "absent from the pool" or "read-only" — so a repoint away from a disk
 *     that stayed enabled and writable (which it must be: it holds the history)
 *     left the assignment standing forever, and cameras 1439 and 3839 were
 *     still writing to `recordingsLow:default` hours after eleven of their
 *     thirteen peers had moved to `recordingsLow:ssd`.
 *   - A standing disagreement between the plan and the class authority is
 *     REPORTED, per camera with its denominator, for as long as it stands. A
 *     spread across two disks is a legitimate thing for the planner to decide;
 *     what is not legitimate is that it looked exactly like a leftover.
 */
import type { CamProfile, IScopedLogger } from '@camstack/types'
import { errMsg, gbToBytes } from '@camstack/types'
import type { RecordingOpsLogSink } from './ops-log-store.js'
import {
  type PlacementCandidate,
  type PlacementDemand,
  type PlacementPlan,
  planPlacement,
} from './placement-planner.js'
import { PlacementRotation } from './placement-rotation.js'
import {
  applyPlacementPass,
  assignmentKey,
  type PlacementPassWrite,
  type RecordingPlacementBlob,
  type RecordingPlacementState,
  readPlacementState,
  rememberVolumeId,
  replaceAssignments,
  writeDevicePin,
  writePlacementPass,
} from './placement-store.js'
import {
  failoverForUnusableLocation,
  fsVolumeProbeDeps,
  probeLocationVolume,
  type VolumeProbeDeps,
  type VolumeProbeResult,
} from './placement-volume.js'
import {
  placementPool,
  placementTypeForProfile,
  type RecordingsLocation,
  resolvePlacement,
} from './roots.js'
import { withDeadline } from './with-deadline.js'

import type { PlacementAlert } from './placement-alerts.js'

export type { PlacementAlert }

/**
 * Free + total bytes on a location's volume; null when unstattable.
 *
 * `error` is where the silence started. `readLocationCapacity` deliberately
 * models its failure and sends the reason back with the nulls — "a bare
 * `catch {}` made a dead NAS and a filesystem with no capacity notion produce
 * byte-identical payloads and not one log line" — and this narrower structural
 * twin dropped the field, so the reason was erased at the type boundary before
 * anyone could decide to log it.
 */
export interface PlacementCapacity {
  readonly availableBytes: number | null
  readonly totalBytes: number | null
  /** Why capacity is unknown. Absent when the volume answered. */
  readonly error?: string
}

/** One (camera, profile) the planner should place. */
export interface PlacementWorkItem {
  readonly deviceId: number
  readonly profile: CamProfile
}

/** One line of the placement census: how many (camera, profile) assignments a
 *  location holds, and out of how many for its class. */
interface PlacementCensusLine {
  readonly locationId: string
  readonly type: string
  readonly assignments: number
  readonly ofClass: number
}

export interface PlacementServiceDeps {
  readonly logger: IScopedLogger
  /** Snapshot of resolved recordings locations (already alias-guarded). */
  readonly locations: () => readonly RecordingsLocation[]
  readonly state: RecordingPlacementState
  readonly opsLog: RecordingOpsLogSink
  /** Marker I/O for the mount probe; defaults to the real filesystem. */
  readonly probe?: VolumeProbeDeps
  /** Surface a mount fault as a liveness alert. Best-effort, never throws. */
  readonly alert?: (input: PlacementAlert) => void
  /** A location that was faulted passed its volume probe again. */
  readonly recovered?: (locationId: string) => void
  /** `statfs` of a location's root. Absent, or answering nulls, → headroom is
   *  UNMEASURABLE (`null`): the planner balances evenly, and no location is
   *  evacuated for a capacity nobody could read. */
  readonly capacityFor?: (location: RecordingsLocation) => Promise<PlacementCapacity>
  /** Bytes recordings already occupy on one location. Answered by an
   *  aggregation over the durable hour ledger — never by counting the rows an
   *  in-RAM index happens to hold, which is a walk over the whole archive. */
  readonly usedOnLocation?: (locationId: string) => Promise<number>
  /** Measured bytes/day for one (camera, profile); 0 before anything is known. */
  readonly dailyBytesFor?: (deviceId: number, profile: CamProfile) => number
  /** Clock, injected so the all-unusable backoff is testable. */
  readonly now?: () => number
  /** Backoff before every-location-unusable is re-probed. Defaults to
   *  {@link ALL_UNUSABLE_REPROBE_MS}. */
  readonly reprobeMs?: number
  /** Bound on one addon-store round trip. Defaults to
   *  {@link PLACEMENT_STORE_TIMEOUT_MS}. */
  readonly storeTimeoutMs?: number
}

/** Free space a location keeps in reserve when its config names no floor. */
const DEFAULT_MIN_FREE_PERCENT = 10

/**
 * How long placement waits before re-probing when EVERY location is unusable.
 *
 * The probe is deliberately a claim and not a poll — it runs once per location
 * per location-set generation — and the generation only turns over on
 * `refreshLocations()`, which the recorder calls at boot, on a storage
 * migration, and on an operator rescan. Nothing else notices a disk that mounts
 * later, so without this the terminal state would be terminal for the life of
 * the process: an operator who fixed the mount would still have to restart the
 * addon. Sixty seconds is slow enough that the fault state costs one probe per
 * location per minute, and fast enough that a fixed mount is picked up before
 * an operator has finished reading the log line.
 */
export const ALL_UNUSABLE_REPROBE_MS = 60_000

/**
 * Bound on EVERY addon-store round trip the 30 s placement pass makes.
 *
 * The store lives in another process (`hub/sqlite-settings`) behind a UDS door
 * whose default bound is 60 s. That default is a backstop for a hung peer, not
 * a budget for a pass that beats every 30 s — and the pass makes its store calls
 * SERIALLY, so an unbounded chain of them costs a multiple of a minute. The
 * recorder logged `durationMs: 240003` (2026-08-18) and `240102` (08-19) — four
 * round trips at the default — and `181056` (08-25) for three. Because
 * `startPeriodicPass` skips a fire while a run is in flight, those four minutes
 * cancelled the SEVEN placement ticks behind them.
 *
 * 5 s is three orders of magnitude above the healthy round trip (the
 * `placementMs` on a live writer spawn is 3–18 ms for SIX of these calls) and
 * leaves the whole pass, worst case, at a fraction of its budget. A store that
 * cannot answer in 5 s has nothing placement wants: the pass gives up, changes
 * nothing, and the next tick — 30 s later, not 4 minutes — asks again.
 */
export const PLACEMENT_STORE_TIMEOUT_MS = 5_000

/**
 * How long the placement CENSUS waits before it is re-announced unchanged.
 *
 * "Who writes where" has no single-word answer once a class writes to several
 * disks at once (D383), so the census replaces the old class-authority
 * divergence report: one line per location per class, always with its
 * denominator (D277). It fires whenever the distribution CHANGES — that is the
 * event — and this is only the heartbeat under it, so an operator who arrives
 * an hour into a rebalance still finds a current line instead of one scrolled
 * off the top. A per-attach line was the alternative and is its own defect: 26
 * assignments re-announced on a 30 s tick is 52 lines a minute saying nothing
 * new.
 */
export const PLACEMENT_CENSUS_REPORT_MS = 3_600_000

/** Nothing planned, nothing to persist. */
const NO_PLAN: PlacementPlan = { assignments: new Map(), changes: [] }

/** Operator pins win over the planner for high/mid of the pinned camera. */
function overlayPins(
  planned: ReadonlyMap<string, string>,
  pins: Readonly<Record<string, string>>,
): Map<string, string> {
  const next = new Map(planned)
  for (const [id, locationId] of Object.entries(pins)) {
    const deviceId = Number(id)
    if (!Number.isFinite(deviceId)) continue
    next.set(assignmentKey(deviceId, 'high'), locationId)
    next.set(assignmentKey(deviceId, 'mid'), locationId)
  }
  return next
}

/** What {@link PlacementService.memoryCensus} reports. */
export interface PlacementServiceCensus {
  readonly verified: number
  readonly unusable: number
  readonly capacityFaults: number
  readonly allUnusableReported: number
}

export class PlacementService {
  /** Locations whose volume has been probed since the last location change. */
  private readonly verified = new Set<string>()
  /** Locations the probe declared unusable — re-probed after a change. */
  private readonly unusable = new Set<string>()
  /** Locations with an OPEN mount-fault alert. Survives a re-resolve (unlike
   *  `unusable`): the alert closes only when the probe verifies the volume. */
  private readonly faulted = new Set<string>()
  /** Locations whose capacity could not be read, by reason. One line per
   *  distinct fault (this is on the 30 s tick) and one when it clears. */
  private readonly capacityFaults = new Map<string, string>()
  /** Cameras that have already announced "every location is unusable". One line
   *  per camera per episode: the fault is asked per-camera, and repeating it per
   *  attach is the noise this state exists to end. */
  private readonly allUnusableReported = new Set<number>()
  /** When the current all-unusable episode last (re-)probed. `null` ⇒ no
   *  episode in progress. */
  private allUnusableProbedAt: number | null = null
  /** The fair tie-break the PURE planner defers to (D37). Advisory state, and
   *  consulted only for a tie the capacity signal cannot separate. */
  private readonly rotation = new PlacementRotation()
  /** The census last announced, as a stable signature. `null` ⇒ nothing
   *  announced yet. */
  private censusSignature: string | null = null
  /** When the census was last announced. */
  private censusReportedAt: number | null = null

  constructor(private readonly deps: PlacementServiceDeps) {}

  /** Entry counts of the per-location/per-camera state, for the recorder census. */
  memoryCensus(): PlacementServiceCensus {
    return {
      verified: this.verified.size,
      unusable: this.unusable.size,
      capacityFaults: this.capacityFaults.size,
      allUnusableReported: this.allUnusableReported.size,
    }
  }

  private get probeDeps(): VolumeProbeDeps {
    return this.deps.probe ?? fsVolumeProbeDeps
  }

  private get now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private get reprobeMs(): number {
    return this.deps.reprobeMs ?? ALL_UNUSABLE_REPROBE_MS
  }

  private get storeTimeoutMs(): number {
    return this.deps.storeTimeoutMs ?? PLACEMENT_STORE_TIMEOUT_MS
  }

  /**
   * Forget every probe verdict. Called whenever the location set is re-resolved
   * (rescan, storage migration) — a remount is exactly the event the probe
   * exists to catch, so a cached "verified" must not survive it.
   */
  onLocationsChanged(): void {
    this.verified.clear()
    this.unusable.clear()
    // A re-resolve ends the episode: the next fault is a NEW one and has to
    // announce itself, or a second outage would look like the first one still
    // running.
    this.allUnusableReported.clear()
    this.allUnusableProbedAt = null
  }

  /**
   * Resolve the location for one (camera, profile) at an attach boundary.
   * Throws only where `resolvePlacement` already threw — no writable location
   * at all, which must stay loud because recording cannot start.
   */
  async place(deviceId: number, profile: CamProfile): Promise<RecordingsLocation> {
    const pool = this.pool()
    this.reprobeAfterBackoff(pool)
    const assigned = await this.assignedLocation(deviceId, profile, pool)
    // Only an UNPLACED camera pays for the capacity read: the bootstrap pick
    // wants the same headroom signal the planner balances on, so the first
    // segments do not land on a disk the next tick immediately moves it off.
    const resolved = assigned ?? resolvePlacement(await this.withHeadroom(pool), profile)
    const usable = await this.ensureUsable(resolved, pool, profile, deviceId)
    if (this.everyLocationUnusable(pool)) {
      // TERMINAL for this episode. `resolved`, not `usable`: the chosen target
      // is where the stored assignment (or the pure resolver) already points, so
      // it does not move from attach to attach, and nothing durable is written.
      this.reportEveryLocationUnusable(deviceId, profile, resolved, pool)
      return resolved
    }
    this.allUnusableReported.delete(deviceId)
    await this.recordDecision(deviceId, profile, usable, resolved.id === usable.id)
    return usable
  }

  /**
   * Has the marker probe declared this location's volume NOT the one we last
   * wrote to?
   *
   * Read by the segment-hour ledger: a walk over a root whose volume failed its
   * probe found nothing because nothing is mounted there, and that must never be
   * allowed to delete durable rows (D49). Unprobed ⇒ usable, which is honest —
   * the probe runs at the first writer attach, so at boot it has usually not run
   * at all, and the ledger's own magnitude guard covers that window.
   */
  isLocationUsable(locationId: string): boolean {
    return !this.unusable.has(locationId)
  }

  /** True when the pool is non-empty and the probe has failed EVERY member. */
  private everyLocationUnusable(pool: readonly RecordingsLocation[]): boolean {
    return pool.length > 0 && pool.every((location) => this.unusable.has(location.id))
  }

  /**
   * Announce the terminal state — ONCE per camera per episode.
   *
   * Before this, two unusable locations produced an infinite failover
   * ping-pong: `failoverForUnusableLocation` did not consult the unusable set,
   * so each attach handed back the other broken disk, `recordDecision` saw a
   * changed assignment and wrote the store plus an audit row, and the writer
   * hit EACCES on a path that was never going to work. Measured on the live hub
   * on 2026-08-19 with the UD disk unmounted: 716 EACCES/min.
   *
   * Recording is NOT refused. With a single location this state is reached the
   * moment that one location fails, and the recorder keeps attaching to it on
   * purpose — a shouting recorder beats a stopped camera. What changes is that
   * it shouts once instead of once per attach, and writes nothing durable while
   * shouting.
   */
  private reportEveryLocationUnusable(
    deviceId: number,
    profile: CamProfile,
    target: RecordingsLocation,
    pool: readonly RecordingsLocation[],
  ): void {
    this.allUnusableProbedAt ??= this.now
    if (this.allUnusableReported.has(deviceId)) return
    this.allUnusableReported.add(deviceId)
    this.deps.logger.warn(
      'recorder placement: EVERY recordings location failed its volume probe — the assignment is FROZEN on its current target and nothing more is written until a disk comes back',
      {
        tags: { deviceId },
        meta: {
          profile,
          targetLocationId: target.id,
          root: target.root,
          locationIds: pool.map((location) => location.id),
          reprobeMs: this.reprobeMs,
        },
      },
    )
  }

  /**
   * While every location is unusable, re-probe them all — at most once per
   * {@link ALL_UNUSABLE_REPROBE_MS}. This is the backoff: without it the probe
   * memo would hold for the life of the process (only `onLocationsChanged`
   * clears it) and a disk remounted by an operator would need an addon restart
   * to be noticed.
   */
  private reprobeAfterBackoff(pool: readonly RecordingsLocation[]): void {
    if (!this.everyLocationUnusable(pool)) {
      this.allUnusableProbedAt = null
      return
    }
    const now = this.now
    if (this.allUnusableProbedAt === null) {
      this.allUnusableProbedAt = now
      return
    }
    if (now - this.allUnusableProbedAt < this.reprobeMs) return
    this.allUnusableProbedAt = now
    this.deps.logger.info(
      'recorder placement: re-probing every storage location after backoff — a disk that came back is picked up here',
      { meta: { locationIds: pool.map((location) => location.id), backoffMs: this.reprobeMs } },
    )
    this.unusable.clear()
    this.verified.clear()
  }

  /**
   * The locations placement may write to: operator-ENABLED and alias-guarded.
   * A location the operator has not opted in is still read, swept and drained —
   * it is simply never a write target. Creating a disk must not start writing
   * to it, so an unknown flag is the only thing that counts as opted in.
   */
  private pool(): readonly RecordingsLocation[] {
    const { locations, fellBackToDisabled } = placementPool(this.deps.locations())
    if (fellBackToDisabled) {
      this.deps.logger.warn(
        'recorder placement: NO recordings location is enabled for writing — writing to a ' +
          'DISABLED location under protest. Enable one in Storage.',
        { meta: { locationIds: locations.map((l) => l.id) } },
      )
    }
    return locations
  }

  /**
   * The stored assignment for one (camera, profile), when it is still valid.
   *
   * Two things invalidate it, and under the operator's model (D383) there is
   * nothing else that can:
   *
   *   1. the location is absent from the current POOL — deleted, or the
   *      operator disabled it. The pool is the single write authority, so an
   *      assignment naming a location outside it is not a divergence to report,
   *      it is unrepresentable;
   *   2. the location is read-only (an operator drain).
   *
   * There used to be a third — "the class was REPOINTED under it", measured
   * against the class default stamped in the blob (D301). It existed only
   * because the default was a SECOND write authority layered over the pool and
   * the two could disagree. With the default deleted the disagreement cannot be
   * expressed: a location leaving the pool already invalidates every assignment
   * naming it, and the planner then moves those keys with `reason: 'gone'`.
   */
  private async assignedLocation(
    deviceId: number,
    profile: CamProfile,
    pool: readonly RecordingsLocation[],
  ): Promise<RecordingsLocation | null> {
    let blob: RecordingPlacementBlob
    try {
      blob = await readPlacementState(this.deps.state)
    } catch (err: unknown) {
      // A fallible read never destroys work (D49): fall through to a fresh
      // resolve, which is what an unassigned camera already does.
      this.deps.logger.warn('recorder placement: assignment read failed — resolving fresh', {
        tags: { deviceId },
        meta: { profile, error: errMsg(err) },
      })
      return null
    }
    const assignedId = blob.assignments[assignmentKey(deviceId, profile)]
    const pinId = blob.pins[String(deviceId)]
    if (pinId !== undefined && (profile === 'high' || profile === 'mid')) {
      const pinned = pool.find((l) => l.id === pinId && !l.readOnly) ?? null
      if (pinned !== null) return pinned
    }
    if (assignedId === undefined) return null
    const location = pool.find((l) => l.id === assignedId && !l.readOnly) ?? null
    if (location === null) {
      // A branch that DROPS a stored decision says so: silence reads as "it was
      // never assigned", and this is exactly the moment an operator asks why a
      // camera moved disk.
      this.deps.logger.info(
        'recorder placement: stored assignment INVALIDATED — its location is not a write target any more (disabled, read-only, or gone). Resolving fresh from the pool.',
        {
          tags: { deviceId },
          meta: {
            profile,
            assignedLocationId: assignedId,
            poolLocationIds: pool.filter((l) => !l.readOnly).map((l) => l.id),
          },
        },
      )
    }
    return location
  }

  /** The pool, with each member's measured headroom attached. One capacity read
   *  per location; used only on the bootstrap path, never per segment. */
  private async withHeadroom(
    pool: readonly RecordingsLocation[],
  ): Promise<readonly RecordingsLocation[]> {
    const candidates = await this.candidatesFor(pool)
    const byId = new Map(candidates.map((c) => [c.locationId, c.headroomBytes]))
    return pool.map((location) => {
      // Absent and null mean the same thing to `RecordingsLocation` — "not
      // measured", which `emptiestOf` already handles — so an unmeasurable
      // location keeps the field absent rather than claiming a zero.
      const headroomBytes = byId.get(location.id)
      return headroomBytes === undefined || headroomBytes === null
        ? location
        : { ...location, headroomBytes }
    })
  }

  /**
   * Re-plan the (camera, profile) pairs in `work` over the current locations.
   * Runs on the controller's existing 30s tick — it changes the PLAN only; a
   * running writer keeps its root until it next attaches. Returns the plan so a
   * caller can log or assert on it.
   *
   * ONE read and, at most, ONE write. Both bounded
   * ({@link PLACEMENT_STORE_TIMEOUT_MS}) and both against the same blob: the
   * plan the pass reads is the plan it writes back.
   *
   * **`work` is a SUBSET and the record is fleet-wide.** The write MERGES
   * (`writePlacementPass`) and deletes only the keys a repoint invalidated. It
   * used to REPLACE the record with `plan.assignments`, which since D287 meant
   * a (camera, profile) with no rows resident in the RAM index vanished from
   * the durable blob on the next tick that changed anything — and an
   * `enabledDeviceIds` timeout narrows `work` to the ACTIVE cameras, so one
   * slow settings door would have dropped every idle one (D299).
   */
  async recompute(work: readonly PlacementWorkItem[]): Promise<PlacementPlan> {
    const pool = this.pool()
    const candidates = await this.candidatesFor(pool)
    const demands: PlacementDemand[] = work.map((item) => ({
      key: assignmentKey(item.deviceId, item.profile),
      type: placementTypeForProfile(item.profile),
      dailyBytes: this.deps.dailyBytesFor?.(item.deviceId, item.profile) ?? 0,
    }))

    let blob: RecordingPlacementBlob
    try {
      blob = await this.bounded(readPlacementState(this.deps.state), 'placement plan read')
    } catch (err: unknown) {
      // D49: a read that FAILS changes nothing. This used to fall through to an
      // EMPTY `current`, which reads every camera as `unassigned` — the exact
      // input that throws stickiness away, lets the planner redistribute the
      // whole fleet by weight, and persists that on the evidence that the
      // settings door was briefly unreachable. A moved assignment costs a
      // writer restart and a recording gap at the next attach, so an
      // unreachable store must cost a SKIPPED tick and nothing else.
      this.deps.logger.warn(
        'recorder placement: plan read failed — this tick plans NOTHING and the stored plan stands',
        { meta: { error: errMsg(err), timeoutMs: this.storeTimeoutMs } },
      )
      return NO_PLAN
    }
    // What the planner sticks to: the stored record as it is. The operator's
    // instruction IS pool membership now (D383) — an assignment naming a
    // location outside the pool is dropped by `planPlacement` itself, with
    // `reason: 'gone'`, and there is no second authority to reconcile against.
    const current = new Map(Object.entries(blob.assignments))

    // `headroomBytes: null` is UNMEASURABLE and must never reach this set: an
    // unreadable `statfs` is not a full disk, and evacuating on it moves every
    // camera off a healthy location (a writer restart and a recording gap
    // each) on the strength of a reading nobody took.
    const evacuate = new Set(
      candidates
        .filter((c) => c.headroomBytes !== null && c.headroomBytes <= 0)
        .map((c) => c.locationId),
    )
    for (const location of pool) if (location.readOnly) evacuate.add(location.id)

    const plan = planPlacement({
      candidates,
      demands,
      current,
      evacuate,
      breakTie: (tied) => this.rotation.next(tied),
    })

    const pass: PlacementPassWrite = {
      planned: overlayPins(plan.assignments, blob.pins),
    }
    // Reported from the record the write WILL produce, via the same pure
    // function the write uses — never from a second reading of the rule.
    this.reportCensus(applyPlacementPass(blob.assignments, pass), pool)

    // Nothing moved: the steady state writes nothing, exactly as before.
    if (plan.changes.length === 0) return plan

    for (const change of plan.changes) {
      const deviceId = Number(change.key.split(':')[0])
      this.deps.logger.info('recorder placement: plan moves a profile to another location', {
        ...(Number.isFinite(deviceId) ? { tags: { deviceId } } : {}),
        meta: { key: change.key, from: change.from, to: change.to, reason: change.reason },
      })
    }
    try {
      await this.bounded(writePlacementPass(this.deps.state, blob, pass), 'placement plan write')
    } catch (err: unknown) {
      this.deps.logger.warn('recorder placement: plan persist failed', {
        meta: { error: errMsg(err), timeoutMs: this.storeTimeoutMs },
      })
    }
    return plan
  }

  /**
   * WHERE THE FLEET WRITES — one line per (class, location), always with its
   * denominator (D277).
   *
   * This replaced the class-authority divergence report (D301) when the default
   * was deleted: with every enabled location of a class a legitimate target,
   * "this camera does not write to THE location" is not a fact any more, while
   * "recordings: 9 of 13 on recordings:default, 4 on recordings:hgst" is
   * exactly the question an operator asks after enabling a second disk. A pool
   * member holding ZERO assignments is listed too — an enabled disk nothing
   * lands on is the failure this whole model exists to make visible.
   *
   * Fires on a CHANGE of the distribution, and otherwise at most once per
   * {@link PLACEMENT_CENSUS_REPORT_MS}.
   */
  private reportCensus(
    assignments: ReadonlyMap<string, string>,
    pool: readonly RecordingsLocation[],
  ): void {
    const counts = new Map<string, number>()
    const perClass = new Map<string, number>()
    for (const location of pool) if (!location.readOnly) counts.set(location.id, 0)
    for (const [key, locationId] of assignments) {
      counts.set(locationId, (counts.get(locationId) ?? 0) + 1)
      const type = placementTypeForProfile(key.split(':')[1] ?? '')
      perClass.set(type, (perClass.get(type) ?? 0) + 1)
    }
    const typeOf = new Map(pool.map((location) => [location.id, location.type]))
    const lines: PlacementCensusLine[] = [...counts.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([locationId, count]) => {
        const type = typeOf.get(locationId) ?? locationId.split(':')[0] ?? locationId
        return {
          locationId,
          type,
          assignments: count,
          ofClass: perClass.get(type) ?? 0,
        }
      })

    const signature = lines
      .map((line) => `${line.locationId}=${String(line.assignments)}`)
      .join(',')
    const now = this.now
    const due =
      this.censusReportedAt === null || now - this.censusReportedAt >= PLACEMENT_CENSUS_REPORT_MS
    if (signature === this.censusSignature && !due) return
    this.censusSignature = signature
    this.censusReportedAt = now
    if (lines.length === 0) return

    this.deps.logger.info('recorder placement: census — which locations the fleet writes to', {
      meta: {
        locations: lines.map((line) => ({
          locationId: line.locationId,
          type: line.type,
          assignments: line.assignments,
          ofClass: line.ofClass,
        })),
      },
    })
    for (const line of lines) {
      if (line.assignments > 0) continue
      this.deps.logger.warn(
        'recorder placement: this location is ENABLED but holds no assignment — nothing writes to it',
        { meta: { locationId: line.locationId, type: line.type, ofClass: line.ofClass } },
      )
    }
  }

  /** Bound one addon-store round trip. See {@link PLACEMENT_STORE_TIMEOUT_MS}. */
  private bounded<T>(promise: Promise<T>, label: string): Promise<T> {
    return withDeadline(promise, this.storeTimeoutMs, label)
  }

  /**
   * The write targets and what each can still absorb — the SAME pool and the
   * SAME headroom `recompute` plans over.
   *
   * Exposed for the operator-armed rebalance (D116): weighing existing footage
   * against a second, independently-derived idea of "what fits" is how the two
   * halves end up disagreeing, and a rebalance that plans onto a location the
   * planner would never write to is a rebalance that undoes itself on the next
   * tick. A location absent from this list is not a write target at all.
   */
  async candidates(): Promise<readonly PlacementCandidate[]> {
    return this.candidatesFor(this.pool())
  }

  /**
   * The plan in force: `<deviceId>:<profile>` → locationId. Empty when the
   * store cannot be read — a fallible read decides nothing (D49), and an empty
   * plan makes the rebalance report every pile as `unassigned` rather than
   * inventing moves.
   */
  async currentAssignments(): Promise<ReadonlyMap<string, string>> {
    try {
      return new Map(Object.entries((await readPlacementState(this.deps.state)).assignments))
    } catch (err: unknown) {
      this.deps.logger.warn('recorder placement: assignment read failed — reporting no plan', {
        meta: { error: errMsg(err) },
      })
      return new Map()
    }
  }

  async placementView(): Promise<{
    readonly assignments: ReadonlyArray<{ deviceId: number; profile: string; locationId: string }>
    readonly pins: ReadonlyArray<{ deviceId: number; locationId: string }>
    readonly defaultLocations: Readonly<Record<string, string>>
  }> {
    const blob = await readPlacementState(this.deps.state)
    const assignments = Object.entries(blob.assignments).flatMap(([key, locationId]) => {
      const [idPart, profile] = key.split(':')
      const deviceId = Number(idPart)
      if (!Number.isFinite(deviceId) || profile === undefined) return []
      return [{ deviceId, profile, locationId }]
    })
    const pins = Object.entries(blob.pins).flatMap(([id, locationId]) => {
      const deviceId = Number(id)
      if (!Number.isFinite(deviceId)) return []
      return [{ deviceId, locationId }]
    })
    return { assignments, pins, defaultLocations: blob.defaultLocations }
  }

  async setDevicePin(deviceId: number, locationId: string | null): Promise<void> {
    if (locationId !== null) {
      const pool = this.pool()
      const loc = pool.find((l) => l.id === locationId && l.type === 'recordings' && !l.readOnly)
      if (!loc) {
        throw new Error(
          `Cannot pin camera ${String(deviceId)} to "${locationId}" — it is not a writable recordings location`,
        )
      }
    }
    await writeDevicePin(this.deps.state, deviceId, locationId)
    this.deps.logger.info('recorder placement: operator pin updated', {
      tags: { deviceId },
      meta: { locationId },
    })
  }

  /**
   * Turn each pool location into a planner candidate. Headroom is
   * `min(free − minFree floor, maxUsedGb − used)`, clamped at zero: the first
   * term is the per-location free-space guard the storage pressure manager also
   * enforces, the second an optional operator cap on what recordings may take.
   *
   * **Nothing measurable is `null`, not zero.** `readLocationCapacity` models
   * its failure — a NAS that stops answering `statfs` returns nulls AND the
   * reason. This method used to discard the reason and fold the whole case into
   * `headroomBytes: 0`, which `recompute` reads as "at its limit" and puts in
   * `evacuate`: one failed `statfs` moved every camera off a healthy disk, and
   * not one line was written about it. (The comment that used to sit here
   * claimed the opposite — "no signal → the planner splits evenly" — which is
   * true of the PLANNER's weights and was never true of the evacuation set.)
   *
   * So an unmeasurable location gets `null`, which is not evacuated and wins no
   * new work, and the reason is logged against the location — once per distinct
   * fault, since this runs on the 30 s placement tick, plus one line when it
   * recovers.
   */
  private async candidatesFor(
    pool: readonly RecordingsLocation[],
  ): Promise<readonly PlacementCandidate[]> {
    const out: PlacementCandidate[] = []
    for (const location of pool) {
      if (location.readOnly) continue
      const capacity = (await this.deps.capacityFor?.(location)) ?? {
        availableBytes: null,
        totalBytes: null,
        error: 'no capacity source is wired on this node',
      }
      const limits: number[] = []
      if (capacity.availableBytes !== null && capacity.totalBytes !== null) {
        const floor =
          ((location.minFreePercent ?? DEFAULT_MIN_FREE_PERCENT) / 100) * capacity.totalBytes
        limits.push(capacity.availableBytes - floor)
      }
      if (location.maxUsedGb !== undefined) {
        const used = (await this.deps.usedOnLocation?.(location.id)) ?? 0
        // BINARY GB, through the one converter (D385). This read used 10⁹
        // while the orchestrator's cap used 1024³ for the SAME stored key, so
        // a location with a cap set was 7.4% off on this side of the pipe.
        limits.push(gbToBytes(location.maxUsedGb) - used)
      }
      const headroomBytes = limits.length === 0 ? null : Math.max(0, Math.min(...limits))
      this.reportCapacitySignal(location, headroomBytes, capacity.error)
      out.push({ locationId: location.id, type: location.type, headroomBytes })
    }
    return out
  }

  /**
   * Say it out loud when a location's capacity cannot be read, and say it again
   * when it comes back. Deduplicated by reason because `candidatesFor` runs on
   * every placement tick — a line per tick is a line nobody reads, and no line
   * at all is what let a dead NAS look like a full one.
   */
  private reportCapacitySignal(
    location: RecordingsLocation,
    headroomBytes: number | null,
    error: string | undefined,
  ): void {
    const previous = this.capacityFaults.get(location.id)
    if (headroomBytes !== null) {
      if (previous !== undefined) {
        this.capacityFaults.delete(location.id)
        this.deps.logger.info(
          'recorder placement: capacity readable again — this location is a write target once more',
          {
            meta: { locationId: location.id, root: location.root, previousError: previous },
          },
        )
      }
      return
    }
    const reason = error ?? 'the capacity read returned no bytes and no reason'
    if (previous === reason) return
    this.capacityFaults.set(location.id, reason)
    this.deps.logger.warn(
      'recorder placement: capacity UNMEASURABLE — headroom is unknown, so this location is neither evacuated nor given new cameras',
      { meta: { locationId: location.id, root: location.root, error: reason } },
    )
  }

  /**
   * Volume-check the chosen location, failing the assignment over to a sibling
   * when the bytes under its root are not the bytes we wrote. The probe runs
   * ONCE per location per location-set generation — it is a claim, not a poll.
   */
  private async ensureUsable(
    chosen: RecordingsLocation,
    locations: readonly RecordingsLocation[],
    profile: CamProfile,
    deviceId: number,
  ): Promise<RecordingsLocation> {
    if (this.unusable.has(chosen.id)) {
      return failoverForUnusableLocation(chosen, locations, profile, this.unusable)
    }
    if (this.verified.has(chosen.id)) return chosen

    const blob = await readPlacementState(this.deps.state)
    const remembered = blob.volumeIds[chosen.id] ?? null
    const result = await probeLocationVolume(chosen, remembered, this.probeDeps)

    if (result.outcome === 'mismatch') {
      this.unusable.add(chosen.id)
      this.reportMountFault(result, deviceId)
      return failoverForUnusableLocation(chosen, locations, profile, this.unusable)
    }

    if (result.outcome === 'unreadable') {
      // A read that FAILS changes nothing (D49). Keep the assignment and say so.
      this.deps.logger.warn('recorder placement: volume probe unreadable — assignment unchanged', {
        tags: { deviceId },
        meta: { locationId: chosen.id, root: chosen.root, detail: result.detail },
      })
      return chosen
    }

    this.verified.add(chosen.id)
    this.reportMountRecovered(chosen.id)
    if (result.outcome === 'adopted' && result.foundVolumeId !== null) {
      try {
        await rememberVolumeId(this.deps.state, chosen.id, result.foundVolumeId)
      } catch (err: unknown) {
        this.deps.logger.warn('recorder placement: could not remember volume id', {
          tags: { deviceId },
          meta: { locationId: chosen.id, error: errMsg(err) },
        })
      }
      this.deps.logger.info('recorder placement: claimed storage volume', {
        tags: { deviceId },
        meta: { locationId: chosen.id, root: chosen.root, volumeId: result.foundVolumeId },
      })
    }
    return chosen
  }

  /** The probe verified a location that had an open fault: close its alert. */
  private reportMountRecovered(locationId: string): void {
    if (!this.faulted.delete(locationId)) return
    try {
      this.deps.recovered?.(locationId)
    } catch {
      /* the alert surface is advisory — never let it break recording */
    }
  }

  /** One loud line + one alert + one audit row per mount fault. */
  private reportMountFault(result: VolumeProbeResult, deviceId: number): void {
    this.deps.logger.error(
      'recorder placement: storage volume MISMATCH — the disk under this location is not the one it last wrote to; failing over',
      {
        tags: { deviceId },
        meta: {
          locationId: result.locationId,
          root: result.root,
          expectedVolumeId: result.expectedVolumeId,
          foundVolumeId: result.foundVolumeId,
          detail: result.detail,
        },
      },
    )
    try {
      this.faulted.add(result.locationId)
      this.deps.alert?.({
        locationId: result.locationId,
        reason: 'unusable',
        detail: result.detail,
      })
    } catch {
      /* the alert surface is advisory — never let it break recording */
    }
    void this.deps.opsLog.append({
      op: 'relocate',
      reason: 'maintenance',
      deviceId,
      itemsAffected: 0,
      bytesReclaimed: 0,
      actor: 'system',
      detail: `placement: volume mismatch on ${result.locationId} — ${result.detail}`,
    })
  }

  /**
   * Persist the assignment and audit it — but only when it actually changed.
   * The steady state (every attach after the first) writes nothing.
   *
   * The per-attach line carries the camera's location and the one it replaced,
   * tagged with `deviceId`, so "where does 3839 write, and did it move?" is
   * answerable per camera. Which locations the FLEET is spread over is the
   * census's job (D383) — there is no class authority for a single line to be
   * measured against any more.
   */
  private async recordDecision(
    deviceId: number,
    profile: CamProfile,
    location: RecordingsLocation,
    verbatim: boolean,
  ): Promise<void> {
    const key = assignmentKey(deviceId, profile)
    let previous: string | undefined
    try {
      previous = (await readPlacementState(this.deps.state)).assignments[key]
    } catch (err: unknown) {
      this.deps.logger.warn('recorder placement: assignment read failed', {
        tags: { deviceId },
        meta: { profile, error: errMsg(err) },
      })
    }

    this.deps.logger.info('recorder placement: profile assigned to storage location', {
      tags: { deviceId },
      meta: {
        profile,
        locationId: location.id,
        root: location.root,
        previousLocationId: previous ?? null,
        reason: verbatim ? 'resolved' : 'failover',
      },
    })

    if (previous === location.id) return

    try {
      const blob = await readPlacementState(this.deps.state)
      const next = new Map(Object.entries(blob.assignments))
      next.set(key, location.id)
      // `replace` is honest here: `next` IS the whole stored record plus one
      // changed key — this caller read it a line ago.
      await replaceAssignments(this.deps.state, blob, next)
    } catch (err: unknown) {
      this.deps.logger.warn('recorder placement: assignment persist failed', {
        tags: { deviceId },
        meta: { profile, error: errMsg(err) },
      })
    }

    void this.deps.opsLog.append({
      op: 'relocate',
      reason: previous === undefined ? 'maintenance' : 'operator',
      deviceId,
      itemsAffected: 0,
      bytesReclaimed: 0,
      actor: 'system',
      detail:
        previous === undefined
          ? `placement: ${profile} assigned to ${location.id} (${location.root})`
          : `placement: ${profile} moved ${previous} → ${location.id} (${location.root})`,
    })
  }
}
