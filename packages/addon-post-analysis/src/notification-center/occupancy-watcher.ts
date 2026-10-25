/**
 * OccupancyWatcher — the Notification Center's debounced occupancy edge state
 * machine (design `2026-07-24-nc-occupancy-timelapse-design.md` §2.3).
 *
 * PURE module: no I/O, no timers, no wall clock of its own. The clock enters
 * exclusively as the `now` argument to {@link OccupancyWatcher.observe}, so
 * every debounce/sustain window is deterministic and unit-testable. Durability
 * and rule-driven key refresh live in the hosting `NotificationCenter`; this
 * module only owns the in-RAM state map and the edge decision.
 *
 * Per key `(deviceId, zoneId|'@frame', className|'@all', threshold)` it holds a
 * confirmed `{ confirmedCount, occupied, lastChangeAt }` level plus an optional
 * pending edge `{ pendingTargetOccupied, pendingSince }`:
 *
 *   raw occupied ⇔ count ≥ threshold   (maxObjects/capacity parity)
 *
 *   confirmed ─ raw flips the predicate ─▶ pending (pendingSince = now)
 *        ▲                                   │ held ≥ sustainSeconds
 *        │ flip-back before the window       ▼
 *        └────────── cancel ◀──────────  COMMIT → OccupancyEdge
 *
 * PER-THRESHOLD KEYING (A2-review amendment — supersedes design §2.3's
 * min-threshold merge): each distinct `threshold` gets its OWN state entry and
 * its OWN false↔true edges. Two rules with different counts on the same
 * zone/class therefore each fire at their own crossing on a gradual
 * accumulation (0→1→3 fires ≥1 at 1 and ≥3 at 3), and the schema's `>=`/`<=`
 * LEVEL ops map directly onto per-threshold flips. Colliding specs that share
 * the SAME `(zone, class, threshold)` still merge (to the MAX sustain — one
 * watcher serves those co-threshold rules); the committed edge carries its
 * `threshold` plus the raw confirmed count (+ previous) so the engine matches
 * each rule to its own threshold. Fail-closed: a `zoneId` absent from the
 * snapshot tracks no key at all. Pending edges are intentionally NOT persisted —
 * they re-open naturally on the next snapshots after a restart.
 *
 * WHEN vs WHEN-WE-CONCLUDED: a committed edge carries `timestamp` (the `now`
 * it committed at) AND, when it can be dated, `observedAt` — the departing read
 * that armed the pending flip, or the last confirmation of the parked members
 * that vanished on it. The two are separated by `sustainSeconds` plus the wait
 * for the next occupancy sample, which on an on-motion camera is the 300 s
 * parked-object recheck; anchoring a notification's clip on the conclusion is
 * what showed the operator an empty parking space. `observedAt` is ABSENT when
 * unknown and is never filled in from a clock.
 *
 * WHAT IS DURABLE: a committed edge (returned from `observe`) and the COLD SEED
 * (drained from {@link OccupancyWatcher.takeSeededRows}). The seed is durable
 * for the same reason it exists at all — a level nobody remembers is re-invented
 * from the first post-boot snapshot, and a transition that spans the downtime
 * then reads as a phantom re-seed and is lost.
 */

import type { CameraOccupancySnapshot, NcOccupancyCondition } from '@camstack/types'
import { isDetectionMacroClass } from '@camstack/types'

/**
 * WHO produced a snapshot, and therefore what it is allowed to say.
 *
 *  - `scene`  — a real frame went through the detector. It may say anything:
 *    a presence, an absence, a level.
 *  - `census` — the stationary baseline sampler built it from the census
 *    ALONE, with no detector involved (`appendBaselineSamples`, one tick per
 *    60 s). It exists so a detached-but-occupied camera keeps its occupancy
 *    confirmed, and for that it only ever needs to say "still here".
 *
 * A census sample may CONFIRM a presence and may cancel a pending departure.
 * It may not testify to an absence, because a census entry retires only on a
 * FRAME — on observed strikes (D279) or observed time (D501). A census
 * answering `0` is not saying "the spot is empty", it is saying "nothing here
 * is censused": that is `null`, not zero (D393).
 *
 * Cost of not having this type, measured on device 102 on 2026-09-15: three
 * false "Pat è andato via" in twelve minutes on a car that never moved, two
 * of them contradicted by an arrival 46 s and 30 s later. All three were armed
 * by the same `setInterval` — their `observedAt` all landed on `:15.545`.
 */
export type OccupancyEvidence = 'scene' | 'census'

/** Sentinel key segments for the "no zone" (whole-frame) and "no class" scopes. */
const FRAME_SCOPE = '@frame'
const ALL_CLASSES = '@all'
/** Prefix marking the trailing threshold segment (`t<n>`) — makes the grammar
 *  self-describing so a legacy three-segment key can never be mis-parsed as a
 *  four-segment one (the last segment of a legacy key is a className, never a
 *  `t<digits>` token). */
const THRESHOLD_PREFIX = 't'
const THRESHOLD_SEGMENT = /^t(\d+)$/

/** Stable per-(device, zone, class, threshold) key. `zoneId`/`className` absent
 *  collapse to the frame-wide / all-classes sentinels; the trailing `t<n>`
 *  segment carries the capacity threshold so distinct thresholds get distinct
 *  keys (per-threshold edges). */
export type OccupancyKey = string

export function occupancyKey(
  deviceId: number,
  zoneId: string | undefined,
  className: string | undefined,
  threshold: number,
): OccupancyKey {
  return `${deviceId}|${zoneId ?? FRAME_SCOPE}|${className ?? ALL_CLASSES}|${THRESHOLD_PREFIX}${threshold}`
}

/** The scope segments decoded from an {@link OccupancyKey}. */
export interface OccupancyKeyScope {
  readonly deviceId: number
  readonly zoneId?: string
  readonly className?: string
  readonly threshold: number
}

/**
 * Inverse of {@link occupancyKey} — the ONE place the key grammar is decoded, so
 * the durable store (whose column schema drops the derivable
 * `zoneId`/`className`/`threshold`) can reconstruct the full scope on reseed.
 *
 * The four-segment grammar is asserted EXACTLY: at least four segments AND a
 * trailing `t<digits>` threshold marker. A legacy three-segment key (no marker)
 * is REJECTED (`null`) rather than positionally mis-parsed — the durable store
 * then SKIPS that row, so a pre-amendment persisted row cold-re-observes instead
 * of hydrating a corrupt scope (className←threshold, zoneId←class). `deviceId`
 * is the leading numeric segment, `threshold` the trailing `t<n>`, `className`
 * the segment before it, and the (possibly `|`-containing) `zoneId` everything
 * between. Exact per-segment count is impossible because a `zoneId` may itself
 * contain `|`; the trailing marker is the unambiguous grammar discriminator.
 */
export function parseOccupancyKey(key: OccupancyKey): OccupancyKeyScope | null {
  const parts = key.split('|')
  if (parts.length < 4) return null // dev | zone | class | t<n>
  const deviceId = Number(parts[0])
  if (!Number.isFinite(deviceId)) return null
  const thresholdMatch = THRESHOLD_SEGMENT.exec(parts[parts.length - 1] ?? '')
  if (thresholdMatch === null) return null // no marker ⇒ legacy/foreign key: reject
  const threshold = Number(thresholdMatch[1])
  const className = parts[parts.length - 2] ?? ALL_CLASSES
  const zoneId = parts.slice(1, -2).join('|')
  return {
    deviceId,
    ...(zoneId !== FRAME_SCOPE ? { zoneId } : {}),
    ...(className !== ALL_CLASSES ? { className } : {}),
    threshold,
  }
}

/** A watched key spec — device-agnostic (the same spec applies to every device
 *  observed). `threshold` is the occupied capacity (`count ≥ threshold`). */
export interface OccupancyKeySpec {
  readonly zoneId?: string
  readonly className?: string
  readonly threshold: number
  readonly sustainSeconds: number
}

/**
 * The capacity threshold a rule condition keys on. Every op keys on its own
 * `count` EXCEPT `<=` C, which keys on C+1 — the `count ≥ C+1` predicate goes
 * false exactly when the count drops to ≤C (mirrors the engine's
 * `matchesOccupancy`, so the watched key and the matched edge always agree).
 *
 * Exported because the rule tester's "as of now" probe has to compare against
 * the SAME number the watcher does; deriving it twice is how a `<=` rule would
 * dry-run off by one.
 */
export function occupancyThreshold(occ: NcOccupancyCondition): number {
  return occ.op === '<=' ? occ.count + 1 : occ.count
}

/** Map an occupancy condition to the watcher key spec (threshold per
 *  {@link occupancyThreshold}, sustain verbatim). */
export function occupancySpecFromCondition(occ: NcOccupancyCondition): OccupancyKeySpec {
  return {
    ...(occ.zoneId !== undefined ? { zoneId: occ.zoneId } : {}),
    ...(occ.className !== undefined ? { className: occ.className } : {}),
    threshold: occupancyThreshold(occ),
    sustainSeconds: occ.sustainSeconds,
  }
}

/**
 * Prefix of a PARKED object's pseudo-track id (`buildStationarySnapshot`). A
 * parked entry is no longer a tracked object — no track row, no track media —
 * so it can never be a notification's media owner, and offering it as one would
 * cost a lookup that always answers empty.
 */
const STATIONARY_TRACK_PREFIX = 'stationary:'

/** True for a member id that could own track media (see the prefix above). */
function isMediaOwnableTrackId(trackId: string): boolean {
  return trackId.length > 0 && !trackId.startsWith(STATIONARY_TRACK_PREFIX)
}

/**
 * Pick the ONE member track that owns this edge's picture.
 *
 * An occupancy notification used to be text-only always: the edge named no
 * media owner, so `buildEntries` froze none and the dispatcher's ladder had
 * nothing to resolve. The snapshot that produced the edge does list the members
 * being counted, and any one of them owns a frame of this camera at this
 * instant — so the edge names one and the notification resolves it through the
 * ORDINARY `getMediaForOwner('track', …)` call (no occupancy branch anywhere
 * downstream).
 *
 * Which one: the ARRIVAL — a member that was not in the scope at the last
 * confirmed-level sample. On a became-occupied edge that is precisely the
 * object whose entry caused the crossing. With no arrival (the level grew while
 * a flip was already pending, a cold watcher, a became-free edge that still has
 * members) the most recently listed member stands in. With no eligible member
 * at all the edge names nobody and the notification ships text-only BY DESIGN —
 * an empty zone has nothing to photograph, and that is an emptiness, not a
 * defect.
 *
 * Class scoping is honest about its limit: the snapshot lists trackIds per ZONE
 * and does not break them down by class, so a class-scoped edge names a member
 * of the same zone at the same instant — the scene the count is about, never a
 * claim about which object was counted.
 */
export function chooseOccupancyMediaOwner(
  members: readonly string[],
  baseline: readonly string[],
): string | undefined {
  const eligible = [...new Set(members.filter(isMediaOwnableTrackId))]
  if (eligible.length === 0) return undefined
  const before = new Set(baseline)
  return eligible.find((id) => !before.has(id)) ?? eligible[eligible.length - 1]
}

/**
 * The member that LEFT on a became-free edge — the departure's picture (D691).
 *
 * A became-free edge's scope holds nobody (or only who stayed), so
 * {@link chooseOccupancyMediaOwner} can only name someone who is NOT the news.
 * The confirmed-level baseline still lists who was there before the flip, and
 * the baseline is never overwritten while a flip is pending (only an agreeing
 * sample does that, and an agreeing sample cancels the flip) — so at commit it
 * is exactly the "before" picture. A media-ownable member of it that the
 * committing read no longer lists is the track whose departure IS the
 * notification, and its best shot was taken on its way out. The most recently
 * listed one wins, like the arrival rule. A parked entry (`stationary:`) owns
 * no track media and is never named: that departure is pictured from the ring
 * instead (`occupancyStillOwner`).
 */
export function chooseDepartedMediaOwner(
  baseline: readonly string[],
  present: readonly string[],
): string | undefined {
  const still = new Set(present)
  const departed = baseline.filter((id) => isMediaOwnableTrackId(id) && !still.has(id))
  return departed[departed.length - 1]
}

/** A committed occupancy transition, emitted from {@link OccupancyWatcher.observe}. */
export interface OccupancyEdge {
  readonly deviceId: number
  readonly zoneId?: string
  readonly zoneName?: string
  readonly className?: string
  /** Raw confirmed count at commit. */
  readonly count: number
  /** The confirmed count before this edge. */
  readonly previousCount: number
  /** `count ≥ threshold` at commit. */
  readonly occupied: boolean
  /** The capacity threshold of the key this edge belongs to — the engine
   *  matches a rule to the edge whose threshold equals the rule's `count`, so a
   *  ≥1 and a ≥3 rule each fire only on their own crossing (no lossy rebound). */
  readonly threshold: number
  /** The `now` at which the edge committed. */
  readonly timestamp: number
  /**
   * WHEN THE CHANGE HAPPENED, as opposed to {@link timestamp}, which is when
   * the watcher CONCLUDED it — the two differ by the whole `sustainSeconds`
   * window plus, on an on-motion camera, by however long it took for the next
   * occupancy sample to arrive (the parked-object baseline sampler runs every
   * 300 s). Measured on device 102 the gap ran 6–10 minutes, and the operator's
   * "posto libero" clip showed an empty space with nothing leaving it.
   *
   * Two sources, best first (see `observedMomentOf`):
   *  1. The last `lastConfirmedAt` of the parked members that VANISHED on the
   *     departing read — the last instant anyone can honestly point at, the
   *     same fact the stationary registry reports as `observedAt` (D279).
   *  2. Failing that, the `ts` of the snapshot that armed the strike — the
   *     departing read itself.
   *
   * ABSENT = UNKNOWN, never "now": a snapshot with no usable `ts` and no parked
   * member to date the departure gives no honest instant, and inventing one is
   * exactly the defect this field exists to remove. Consumers fall back to
   * {@link timestamp} explicitly and say so.
   */
  readonly observedAt?: number
  /** The member track this edge's notification names as its media owner (see
   *  {@link chooseOccupancyMediaOwner}). Absent when the scope holds no
   *  media-ownable member — the notification then ships text-only. */
  readonly mediaTrackId?: string
}

/** A durable confirmed-state row — reseeded into the RAM map on boot so a
 *  restart mid-occupancy does not re-fire an already-confirmed edge. Pending
 *  edges are deliberately excluded. */
export interface OccupancyStateRow {
  readonly key: OccupancyKey
  readonly deviceId: number
  readonly zoneId?: string
  readonly className?: string
  /** The capacity threshold this confirmed level belongs to (part of the key). */
  readonly threshold: number
  readonly confirmedCount: number
  readonly occupied: boolean
  readonly lastChangeAt: number
  readonly updatedAt: number
}

/** The merged spec actually tracked per partial key (post collision-merge). */
interface MergedSpec {
  readonly zoneId?: string
  readonly className?: string
  readonly threshold: number
  readonly sustainSeconds: number
}

/** In-RAM per-key state. `pending*` are undefined when no edge is in flight. */
interface WatcherState {
  readonly deviceId: number
  readonly zoneId?: string
  readonly className?: string
  readonly threshold: number
  confirmedCount: number
  occupied: boolean
  lastChangeAt: number
  pendingTargetOccupied?: boolean
  pendingSince?: number
  /** The moment the DEPARTING read said the change happened, captured when the
   *  pending flip was armed (see {@link OccupancyEdge.observedAt}). Undefined
   *  when no flip is in flight, and ALSO when one is in flight whose moment is
   *  unknown — the two are the same answer downstream, and neither is "now". */
  pendingObservedAt?: number
  /** Members seen at the last sample that AGREED with the confirmed level — the
   *  "before the edge" set the arrival is measured against
   *  ({@link chooseOccupancyMediaOwner}). Never persisted: a cold key has an
   *  empty baseline, which simply makes every member an arrival. */
  baselineMembers: readonly string[]
  /** `lastConfirmedAt` of the PARKED members of that same agreeing sample. The
   *  departure of a parked object is never witnessed — the registry only stops
   *  listing it — so its last confirmation is the only instant the departure
   *  can honestly be dated to. Never persisted, for `baselineMembers`' reason:
   *  it is a per-frame fact, and after a restart it is simply unknown. */
  baselineStationaryConfirmedAt: ReadonlyMap<string, number>
}

/** Resolve the count for a spec against a snapshot. `null` = fail-closed (the
 *  referenced zone is absent). */
interface ResolvedScope {
  readonly count: number
  readonly zoneName?: string
  /** Track ids of the objects the count is about, as the snapshot lists them.
   *  Zone-scoped: that zone's members. Frame-scoped: the union across zones —
   *  the snapshot lists members per zone only, so an object inside no zone
   *  cannot be named (the frame edge then has no owner). */
  readonly trackIds: readonly string[]
  /** The snapshot's own frame timestamp, when it carries a usable one. Absent
   *  (`0`, negative, non-finite) = UNKNOWN — never substituted with a clock. */
  readonly observedTs?: number
  /** `lastConfirmedAt` per PARKED member of this camera, keyed by the pseudo
   *  track id `buildStationarySnapshot` gives it. Empty when the snapshot lists
   *  no parked object. The one honest date for a departure nobody watched. */
  readonly stationaryConfirmedAt: ReadonlyMap<string, number>
}

/** Device-agnostic partial key (`zone|class|t<threshold>`) — the merge/watch
 *  granularity. Distinct thresholds are distinct partial keys (per-threshold). */
function partialKey(
  zoneId: string | undefined,
  className: string | undefined,
  threshold: number,
): string {
  return `${zoneId ?? FRAME_SCOPE}|${className ?? ALL_CLASSES}|${THRESHOLD_PREFIX}${threshold}`
}

/** The device-agnostic partial key of a full state/edge key — everything after
 *  the leading `deviceId|` segment. */
function partialKeyOf(key: OccupancyKey): string {
  const idx = key.indexOf('|')
  return idx < 0 ? key : key.slice(idx + 1)
}

/**
 * A watched key whose class scope the snapshots can NEVER key on — reported
 * once per key so the operator's log answers "this rule cannot count".
 *
 * The ZoneAnalytics `byClass` record is keyed on MACRO classes only (the
 * executor maps every raw COCO label onto its macro and drops the rest —
 * `COCO_TO_MACRO.preserveOriginal === false`). A key scoped to `car` therefore
 * reads a record entry that does not exist: the count is 0 on every snapshot,
 * the predicate never flips, and no edge can ever commit.
 *
 * That is a DROPPED branch by any other name, and it was silent: two rules on
 * device 102 sat dead for a day (2026-08-12) because the rule editor offered
 * the full taxonomy for the one condition that does not macro-expand. The
 * picker is fixed; this is the guard that says so when a stored rule still
 * carries the dead value.
 */
export interface OccupancyImpossibleScope {
  readonly deviceId: number
  readonly key: OccupancyKey
  readonly zoneId?: string
  readonly className: string
  readonly threshold: number
}

/**
 * A flip that ARMED on this observation (D691) — the watcher cannot commit it
 * before `sustainMs` from now, and only a sample landing after that can. The
 * host turns it into ONE early look (`requestOccupancyLook`), because the
 * session that armed it often closes first and the next sample would
 * otherwise be the 300 s parked-object cadence.
 */
export interface OccupancyArmedFlip {
  readonly deviceId: number
  readonly key: OccupancyKey
  readonly toOccupied: boolean
  /** How long the flip must still hold, from the observation that armed it. */
  readonly sustainMs: number
}

/**
 * Optional reporting sink. Not a logger: the module stays pure of I/O, the host
 * decides what a report costs. Absent ⇒ the watcher behaves exactly as before.
 */
export interface OccupancyWatcherDeps {
  readonly onImpossibleScope?: (scope: OccupancyImpossibleScope) => void
}

export class OccupancyWatcher {
  /** Watched specs, keyed by their device-agnostic partial key. */
  private readonly watched = new Map<string, MergedSpec>()
  /** Confirmed + pending state, keyed by the full {@link OccupancyKey}. */
  private readonly states = new Map<OccupancyKey, WatcherState>()
  /** Rows SEEDED since the last {@link takeSeededRows} — the durable
   *  write-through queue (see that method). */
  private readonly seeded = new Map<OccupancyKey, OccupancyStateRow>()
  /** Keys already reported through `onImpossibleScope` (once-per-key gate).
   *  Pruned with the watched set, so re-authoring a rule reports again. */
  private readonly impossibleReported = new Set<OccupancyKey>()
  /** Flips ARMED since the last {@link takeArmedFlips} (D691). */
  private readonly armed = new Map<OccupancyKey, OccupancyArmedFlip>()
  private readonly deps: OccupancyWatcherDeps

  constructor(deps: OccupancyWatcherDeps = {}) {
    this.deps = deps
  }

  /**
   * Replace the watched key set (rule-driven — recomputed on rule change).
   * Each distinct `(zone, class, threshold)` is its OWN watched partial key
   * (per-threshold edges — NO min-threshold merge). Specs that collide on the
   * SAME `(zone, class, threshold)` merge to the MAX sustain (longest debounce),
   * so one watcher serves those co-threshold rules. Confirmed state for a key
   * that is no longer watched is DROPPED (bounds the RAM map + lets the caller
   * prune the durable row to the active set); a still-watched key retains its
   * level (re-evaluated on the next `observe`).
   */
  setWatchedKeys(specs: readonly OccupancyKeySpec[]): void {
    this.watched.clear()
    for (const spec of specs) {
      const pk = partialKey(spec.zoneId, spec.className, spec.threshold)
      const existing = this.watched.get(pk)
      if (existing === undefined) {
        this.watched.set(pk, {
          ...(spec.zoneId !== undefined ? { zoneId: spec.zoneId } : {}),
          ...(spec.className !== undefined ? { className: spec.className } : {}),
          threshold: spec.threshold,
          sustainSeconds: spec.sustainSeconds,
        })
        continue
      }
      // Same (zone, class, threshold) — keep the longest debounce window.
      this.watched.set(pk, {
        ...existing,
        sustainSeconds: Math.max(existing.sustainSeconds, spec.sustainSeconds),
      })
    }
    // Drop confirmed state for keys no longer watched (rule removed / threshold
    // edited to a different value ⇒ the old key is genuinely stale).
    for (const key of [...this.states.keys()]) {
      if (!this.watched.has(partialKeyOf(key))) this.states.delete(key)
    }
    // Same bound for the two side maps. A seeded row whose key just stopped
    // being watched must NOT be persisted — it would create exactly the row the
    // next `pruneExcept` deletes. And an impossible-scope report is re-armed by
    // the edit, because an operator who just changed the rule is the one person
    // who needs to be told again.
    for (const key of [...this.seeded.keys()]) {
      if (!this.watched.has(partialKeyOf(key))) this.seeded.delete(key)
    }
    for (const key of [...this.impossibleReported]) {
      if (!this.watched.has(partialKeyOf(key))) this.impossibleReported.delete(key)
    }
  }

  /**
   * Feed one camera snapshot at time `now`, returning the edges that COMMIT on
   * this tick (usually none). Every watched key is evaluated for `deviceId`;
   * fail-closed keys (absent zone) are skipped and hold no state.
   */
  observe(
    deviceId: number,
    snapshot: CameraOccupancySnapshot,
    now: number,
    evidence: OccupancyEvidence = 'scene',
  ): readonly OccupancyEdge[] {
    const edges: OccupancyEdge[] = []
    for (const spec of this.watched.values()) {
      const resolved = resolveOccupancyScope(snapshot, spec)
      if (resolved === null) continue // fail-closed: zone absent
      const key = occupancyKey(deviceId, spec.zoneId, spec.className, spec.threshold)
      this.reportImpossibleScope(deviceId, key, spec)
      // A census that sees NOTHING is not an observation of this scope — see
      // {@link OccupancyEvidence}. It may neither establish a level nor move
      // one towards empty, so it is dropped before either can happen.
      const blindCensus = evidence === 'census' && resolved.count < spec.threshold
      const existing = this.states.get(key)
      if (existing === undefined) {
        // A level is born from an OBSERVATION. Seeding a cold key from an
        // empty census would make the first real frame read as an arrival
        // that never happened.
        if (blindCensus) continue
        // FIRST observation of this key — see {@link seedState}. Seeding is a
        // level, not a change, so no `step` runs and no edge can arise: an edge
        // requires a transition between two OBSERVED snapshots.
        const state = seedState(deviceId, spec, resolved, now)
        this.states.set(key, state)
        // The seed is a LEVEL WORTH KEEPING. Queue it for the caller's durable
        // write-through: without it every restart re-seeds cold from whatever
        // the first post-boot snapshot happens to say, and a transition that
        // spans the downtime is lost as a phantom re-seed.
        this.seeded.set(key, stateToRow(key, state, now))
        continue
      }
      // Not a `step` that returns null: the pending state must be left
      // exactly as the scene left it. A blind census that cancelled a pending
      // departure would silence the real one that armed it.
      if (blindCensus) continue
      const pendingBefore = existing.pendingSince
      const edge = step(existing, spec, resolved, now)
      if (edge !== null) {
        edges.push(edge)
        this.armed.delete(key)
        continue
      }
      // A flip ARMED on this observation (a new pendingSince) — offered once.
      const target = existing.pendingTargetOccupied
      if (target !== undefined && existing.pendingSince !== pendingBefore) {
        this.armed.set(key, {
          deviceId,
          key,
          toOccupied: target,
          sustainMs: spec.sustainSeconds * 1_000,
        })
      } else if (target === undefined) {
        this.armed.delete(key)
      }
    }
    return edges
  }

  /**
   * Drain the flips armed since the last call (D691) — one per pending edge,
   * so the host asks for one look per edge, never one per sample. A flip that
   * committed or cancelled before the drain is not offered.
   */
  takeArmedFlips(): readonly OccupancyArmedFlip[] {
    const flips = [...this.armed.values()]
    this.armed.clear()
    return flips
  }

  /**
   * Drain the rows seeded since the last call — the caller persists them
   * through the SAME ledger the committed edges use.
   *
   * Drained rather than exposed because a seed is a ONE-TIME fact: re-offering
   * it would turn a rare write into a per-frame one, which is the thing the
   * edge-only write-through was designed to avoid. Missing a drain costs
   * nothing worse than today's behaviour (a cold re-seed at the next boot), so
   * the caller may fail the write without corrupting anything.
   */
  takeSeededRows(): readonly OccupancyStateRow[] {
    const rows = [...this.seeded.values()]
    this.seeded.clear()
    return rows
  }

  /** Fire `onImpossibleScope` the first time a key with an uncountable class
   *  scope is evaluated. See {@link OccupancyImpossibleScope}. */
  private reportImpossibleScope(deviceId: number, key: OccupancyKey, spec: MergedSpec): void {
    const report = this.deps.onImpossibleScope
    if (report === undefined) return
    const className = spec.className
    if (className === undefined || isDetectionMacroClass(className)) return
    if (this.impossibleReported.has(key)) return
    this.impossibleReported.add(key)
    report({
      deviceId,
      key,
      ...(spec.zoneId !== undefined ? { zoneId: spec.zoneId } : {}),
      className,
      threshold: spec.threshold,
    })
  }

  /** Reseed confirmed state from durable rows (boot). Only rows whose key is
   *  currently WATCHED are restored — an orphaned durable row (its rule gone)
   *  is dropped, keeping the RAM map bounded to the active set. Pending edges
   *  are not restored (fail-closed — they re-open on the next snapshots). */
  hydrate(rows: readonly OccupancyStateRow[]): void {
    for (const row of rows) {
      if (!this.watched.has(partialKeyOf(row.key))) continue
      this.states.set(row.key, {
        deviceId: row.deviceId,
        ...(row.zoneId !== undefined ? { zoneId: row.zoneId } : {}),
        ...(row.className !== undefined ? { className: row.className } : {}),
        threshold: row.threshold,
        confirmedCount: row.confirmedCount,
        occupied: row.occupied,
        lastChangeAt: row.lastChangeAt,
        // Membership is not persisted (it is a per-frame fact, not a level):
        // the first post-boot sample that agrees with the confirmed level
        // refills it, and until then every member reads as an arrival.
        baselineMembers: [],
        // Likewise the parked members' last confirmations: after a restart the
        // date of a departure that spans the downtime is genuinely unknown,
        // and an empty map says so rather than inventing one.
        baselineStationaryConfirmedAt: new Map(),
      })
    }
  }

  /** Snapshot the CONFIRMED state for durable persistence (pending excluded). */
  snapshotState(): readonly OccupancyStateRow[] {
    const rows: OccupancyStateRow[] = []
    for (const [key, state] of this.states) {
      rows.push(stateToRow(key, state, state.lastChangeAt))
    }
    return rows
  }
}

/** The durable projection of one in-RAM state — the ONE place the persisted row
 *  shape is built, so a seeded row and a snapshotted one cannot differ. */
function stateToRow(key: OccupancyKey, state: WatcherState, updatedAt: number): OccupancyStateRow {
  return {
    key,
    deviceId: state.deviceId,
    ...(state.zoneId !== undefined ? { zoneId: state.zoneId } : {}),
    ...(state.className !== undefined ? { className: state.className } : {}),
    threshold: state.threshold,
    confirmedCount: state.confirmedCount,
    occupied: state.occupied,
    lastChangeAt: state.lastChangeAt,
    updatedAt,
  }
}

/**
 * The state a key starts from: WHAT THE FIRST SNAPSHOT SAID.
 *
 * There used to be no such function — a cold key started at
 * `confirmedCount: 0, occupied: false`, a fabricated "the zone is empty" that
 * no snapshot had ever reported. The first real snapshot then read as a 0→N
 * transition and, once sustained, committed a became-occupied edge for a scene
 * that had not changed.
 *
 * That is not a corner case, it is the ORDINARY way a rule begins: an operator
 * writes an occupancy rule about a thing they can see, which means the thing is
 * usually there when they press save. Live on 2026-08-12 a became-occupied rule
 * on zone "Parking pat'" (device 102, class `car`) was authored with the car
 * already parked, and the next analysis pass would have announced its arrival.
 *
 * The invariant, stated once: AN EDGE MAY ONLY ARISE FROM A TRANSITION BETWEEN
 * TWO OBSERVED SNAPSHOTS. One snapshot is a level. Seeding therefore writes the
 * observed count, its predicate and its members, opens NO pending edge, and is
 * not counted as a change — the sustain/debounce machinery is untouched and has
 * nothing to confirm.
 *
 * `lastChangeAt` is the seeding instant. It is the honest answer available: the
 * level has held since at least now, and the watcher cannot know since when in
 * truth. Nothing downstream reads it as a duration.
 *
 * A durable row still WINS — `hydrate` populates the map, so a reseeded key is
 * not cold and takes the ordinary transition path. Only a key with neither a
 * durable row nor RAM state seeds silently.
 */
function seedState(
  deviceId: number,
  spec: MergedSpec,
  resolved: ResolvedScope,
  now: number,
): WatcherState {
  return {
    deviceId,
    ...(spec.zoneId !== undefined ? { zoneId: spec.zoneId } : {}),
    ...(spec.className !== undefined ? { className: spec.className } : {}),
    threshold: spec.threshold,
    confirmedCount: resolved.count,
    occupied: resolved.count >= spec.threshold,
    lastChangeAt: now,
    // The members present at the seed are the "before the edge" picture, so the
    // next arrival is measured against who was already here — otherwise the
    // parked car would be named as the arrival on the first real edge.
    baselineMembers: resolved.trackIds,
    baselineStationaryConfirmedAt: resolved.stationaryConfirmedAt,
  }
}

/** The (zone, class) scope a count is read for — the shared shape of a watcher
 *  spec and a rule condition, so both read a snapshot through ONE function. */
export interface OccupancyScope {
  readonly zoneId?: string
  readonly className?: string
}

/**
 * Read the count (+ zone name + members) for a scope, or `null` when
 * fail-closed (the referenced zone is absent from the snapshot).
 *
 * The ONE place a snapshot is reduced to a count: the live watcher and the
 * rule tester's "as of now" probe both call it, so a dry-run can never disagree
 * with the edge the same snapshot would produce.
 */
export function resolveOccupancyScope(
  snapshot: CameraOccupancySnapshot,
  scope: OccupancyScope,
): ResolvedScope | null {
  const observed = observedFacts(snapshot)
  if (scope.zoneId === undefined) {
    const count =
      scope.className === undefined
        ? snapshot.frame.totalObjects
        : (snapshot.frame.byClass[scope.className] ?? 0)
    return { count, trackIds: snapshot.zones.flatMap((z) => [...z.trackIds]), ...observed }
  }
  const zone = snapshot.zones.find((z) => z.zoneId === scope.zoneId)
  if (zone === undefined) return null // fail-closed: referenced zone absent
  const count =
    scope.className === undefined ? zone.totalObjects : (zone.byClass[scope.className] ?? 0)
  return { count, zoneName: zone.zoneName, trackIds: [...zone.trackIds], ...observed }
}

/**
 * The two WHEN facts a snapshot carries, read once per snapshot read.
 *
 * `ts` is the frame timestamp of the inference result behind the snapshot —
 * usable only when it is a real instant. A fixture (and a legacy snapshot)
 * carries `0`, and folding that into an anchor would put the clip at the epoch,
 * so a non-positive or non-finite `ts` is reported ABSENT, not zero (D393).
 */
function observedFacts(snapshot: CameraOccupancySnapshot): {
  readonly observedTs?: number
  readonly stationaryConfirmedAt: ReadonlyMap<string, number>
} {
  const confirmed = new Map<string, number>()
  for (const entry of snapshot.stationaryObjects ?? []) {
    if (Number.isFinite(entry.lastConfirmedAt) && entry.lastConfirmedAt > 0) {
      confirmed.set(`${STATIONARY_TRACK_PREFIX}${entry.id}`, entry.lastConfirmedAt)
    }
  }
  const ts = snapshot.ts
  return {
    ...(Number.isFinite(ts) && ts > 0 ? { observedTs: ts } : {}),
    stationaryConfirmedAt: confirmed,
  }
}

/**
 * WHEN the change this read is about actually happened — or `undefined`, which
 * means UNKNOWN and must never be filled in with a clock.
 *
 * The answer the operator is owed comes from the parked members that VANISHED
 * between the baseline sample and this one: nobody watches a parked car leave
 * (the registry simply stops listing it), so the last confirmation of the
 * departed entries is the last instant anyone can honestly point at — the same
 * fact and the same reasoning as the stationary registry's own `observedAt`
 * (D279). The MOST RECENT of them is taken: that is the last moment the scene
 * still read as "before".
 *
 * With nothing parked departing — a live object walking out of a zone, an
 * arrival — the departing READ itself is the moment: the snapshot's own frame
 * timestamp. That is already better than the commit instant by the whole
 * sustain window.
 *
 * With neither, the caller is told nothing rather than something invented.
 */
function observedMomentOf(state: WatcherState, resolved: ResolvedScope): number | undefined {
  const present = new Set(resolved.trackIds)
  let departed: number | undefined
  for (const member of state.baselineMembers) {
    if (present.has(member)) continue
    const confirmedAt = state.baselineStationaryConfirmedAt.get(member)
    if (confirmedAt === undefined) continue
    if (departed === undefined || confirmedAt > departed) departed = confirmedAt
  }
  return departed ?? resolved.observedTs
}

/**
 * Advance one key's state by one observation. Mutates `state` in place (the
 * watcher owns it) and returns a committed edge, or `null`.
 */
function step(
  state: WatcherState,
  spec: MergedSpec,
  resolved: ResolvedScope,
  now: number,
): OccupancyEdge | null {
  const rawOccupied = resolved.count >= spec.threshold
  const sustainMs = spec.sustainSeconds * 1_000

  if (rawOccupied === state.occupied) {
    // Predicate matches the confirmed level — cancel any in-flight flip. The
    // confirmed count is only advanced on a boolean edge (edge-only P1).
    state.pendingTargetOccupied = undefined
    state.pendingSince = undefined
    state.pendingObservedAt = undefined
    // This sample IS the "before the edge" picture for the next flip: whoever
    // shows up after it is the arrival that caused it.
    state.baselineMembers = resolved.trackIds
    state.baselineStationaryConfirmedAt = resolved.stationaryConfirmedAt
    return null
  }

  // Raw disagrees with the confirmed occupied predicate — a flip is pending.
  if (state.pendingTargetOccupied !== rawOccupied) {
    state.pendingTargetOccupied = rawOccupied
    state.pendingSince = now
    // Dated from the DEPARTING read, not from the commit that follows it a
    // sustain window later. Captured here and not at commit because the
    // baseline this compares against is overwritten by the very next agreeing
    // sample — by commit time the departed members are no longer missing from
    // anything. `undefined` survives as `undefined` (unknown ≠ now).
    state.pendingObservedAt = observedMomentOf(state, resolved)
  }
  const pendingSince = state.pendingSince ?? now
  if (now - pendingSince < sustainMs) return null // still confirming

  // Sustained — commit the edge.
  const previousCount = state.confirmedCount
  // A departure is pictured on who LEFT (D691); an arrival on who came.
  const mediaTrackId =
    (rawOccupied
      ? undefined
      : chooseDepartedMediaOwner(state.baselineMembers, resolved.trackIds)) ??
    chooseOccupancyMediaOwner(resolved.trackIds, state.baselineMembers)
  const observedAt = state.pendingObservedAt
  state.confirmedCount = resolved.count
  state.occupied = rawOccupied
  state.lastChangeAt = now
  state.pendingTargetOccupied = undefined
  state.pendingSince = undefined
  state.pendingObservedAt = undefined
  // The committed level is the new baseline: the next edge's arrival is
  // measured against who is here NOW.
  state.baselineMembers = resolved.trackIds
  state.baselineStationaryConfirmedAt = resolved.stationaryConfirmedAt
  return {
    deviceId: state.deviceId,
    ...(spec.zoneId !== undefined ? { zoneId: spec.zoneId } : {}),
    ...(resolved.zoneName !== undefined ? { zoneName: resolved.zoneName } : {}),
    ...(spec.className !== undefined ? { className: spec.className } : {}),
    count: resolved.count,
    previousCount,
    occupied: rawOccupied,
    threshold: spec.threshold,
    timestamp: now,
    ...(observedAt !== undefined ? { observedAt } : {}),
    ...(mediaTrackId !== undefined ? { mediaTrackId } : {}),
  }
}
