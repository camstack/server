/**
 * StationaryObjectRegistry — durable per-device registry of parked objects.
 *
 * Holds the promoted {@link StationaryEntry} set in memory (keyed by device →
 * entryId) and mirrors it to a declared SQLite collection so parked cars are
 * NOT re-discovered on every addon respawn. It exposes:
 *
 *  - `filter(...)` — the per-frame gate the FrameProcessor calls just before the
 *    tracker: drops detections that keep confirming a parked object (no track
 *    spawn), reports confirmed entries (for occupancy) and woken entries. It
 *    also OWNS the departure-strike state, which is not entry state.
 *  - `applyFrameOutcome(...)` — folds the frame gate's confirmed/woken lists
 *    back into ENTRY state (advance `lastConfirmedAt`, RE-ANCHOR the box on an
 *    unambiguous read, retire woken).
 *  - `promote(...)` — turn a parked track into a persisted entry.
 *  - `sweep(now)` — retire entries unconfirmed past their TTL + flush advanced
 *    `lastConfirmedAt`s to the store.
 *
 * State mutation is centralised here; the pure decisions live in
 * `stationary-match.ts`.
 *
 * ## An entry is hard to create and must be hard to destroy (D174)
 *
 * Two invariants keep a parked object represented by ONE entry for as long as
 * it is parked, instead of a birth→promotion→retirement cycle:
 *
 *  - **The reference box FOLLOWS its object.** An unambiguous confirmation
 *    re-anchors `bbox`. It used to be frozen at the promotion instant forever,
 *    so the object's own drift eventually walked its centroid out of a box that
 *    no longer described it — and that read as a departure.
 *  - **A departure is confirmed INDEPENDENTLY (D49, D279).** One departing
 *    frame only arms the entry ({@link departureStrikes}); the detection stays
 *    suppressed and nothing is destroyed. The confirmation must land at least
 *    `confirmMinGapMs` later, the strike decays if it never does, a strong
 *    re-confirmation cancels it, and a bare miss never confirms at all.
 *
 * And every retirement is LOGGED with its reason and `tags.deviceId`. It used
 * to be silent, so an operator saw a stream of promotions with nothing to
 * explain what had ended the previous one. The strike lifecycle around it —
 * armed, cancelled, expired, refused during warm-up — fires on the frame path
 * and is therefore rolled up into ONE line per device per sweep.
 */

import type { IScopedLogger } from '@camstack/types'
import { DurableLedger, type DurableLedgerSpec } from '../../../durable/durable-ledger.js'
import { type DurableKindDeps } from '../../../durable/durable-wiring.js'
import { pipelineAnalyticsRecordKinds } from '../../record-kinds.js'
import { isPlausibleThumbnailBox } from '../../best-thumbnail-guard.js'
import { stepStaleAnchor, type WeakRun } from './stale-anchor.js'
import {
  type DepartureStrikeChange,
  findParkedOccupant,
  normaliseStationaryClass,
  partitionDetectionsAgainstRegistry,
  type StationaryConfirmation,
  type StationaryDetectionLike,
  type StationaryWake,
} from './stationary-match.js'
import {
  DEFAULT_DEPARTURE_CONFIG,
  DEFAULT_MATCH_CONFIG,
  ENTRY_TTL_MS,
  entryToView,
  GATE_SESSION_GAP_MS,
  GATE_WARMUP_MS,
  type DepartureStrike,
  type StationaryDepartureConfig,
  type StationaryEntry,
  type StationaryMatchConfig,
  type StationaryObjectView,
} from './stationary-types.js'

/**
 * @durable class=ledger owner=pipeline-analytics
 *   write="a promote/retire TRANSITION (immediate); a re-confirmation is STAGED in RAM and flushed on the 5-minute sweep"
 *   retention="TTL on OBSERVED frame time per device — a retired entry is deleted, never aged by wall clock. Never orphaned by track retention (`sourceTrackId` is a reference, not ownership)."
 */
export const STATIONARY_COLLECTION = 'pipeline-analytics:stationary-objects'

export const STATIONARY_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'className', type: 'TEXT' as const, notNull: true },
  { name: 'bbox', type: 'JSON' as const },
  { name: 'frameWidth', type: 'INTEGER' as const },
  { name: 'frameHeight', type: 'INTEGER' as const },
  { name: 'firstSeenAt', type: 'INTEGER' as const },
  { name: 'becameStationaryAt', type: 'INTEGER' as const },
  { name: 'lastConfirmedAt', type: 'INTEGER' as const },
  { name: 'sourceTrackId', type: 'TEXT' as const },
  { name: 'label', type: 'TEXT' as const },
  { name: 'keyFrameMediaId', type: 'INTEGER' as const },
] as const

const STATIONARY_INDEXES = [
  { name: 'idx_stationary_device', columns: ['deviceId'] as const },
] as const

export type StationaryChangePhase = 'appeared' | 'departed'

/** What {@link StationaryObjectRegistry.promote} did: minted a row, or folded
 *  the promotion into the entry already holding that spot. `entry` is the LIVE
 *  entry either way — never the refused one. */
export interface StationaryPromotion {
  readonly outcome: 'born' | 'merged'
  readonly entry: StationaryEntry
}

export interface StationaryRegistryDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
  readonly matchConfig?: StationaryMatchConfig
  readonly entryTtlMs?: number
  /** Departure-confirmation tunables (D279). Overridable so a test can state
   *  the separation it is exercising instead of sleeping through the real one. */
  readonly departureConfig?: StationaryDepartureConfig
  /** Gap in gate frames that means a new observation session. */
  readonly sessionGapMs?: number
  /** How long after a session opens departure reads are refused. */
  readonly warmUpMs?: number
  /** Per-device observed-time TTL resolver (#31). Returns the entry TTL (ms) for
   *  a device from its live settings; falls back to `entryTtlMs` when absent.
   *  Read at sweep time so an operator's change takes effect within one tick. */
  readonly ttlForDevice?: (deviceId: number) => number | undefined
  /**
   * Fired for every entry that leaves the registry — retired, woken, or
   * collapsed into a duplicate — with the entry as it was. The addon releases
   * the key frame the entry vouched for (D547), if no other entry and no track
   * row still holds it. Optional: a registry built without it leaks nothing
   * new (the row was always there), it merely stops being freed.
   */
  readonly onEntryDropped?: (entry: StationaryEntry) => void
  /**
   * Ask for an out-of-band look at a camera whose departure has just been
   * ARMED and is about to lose its observer.
   *
   * Injected rather than called directly: the registry owns the decision that
   * a look is WARRANTED and knows the two numbers that shape it, while whether
   * a camera can be looked at — attached here? asleep on battery? already
   * bursting? — belongs to the runner, one addon away. Absent means nobody is
   * listening, which is exactly the behaviour before this existed.
   */
  readonly requestConfirmationLook?: (ask: {
    readonly deviceId: number
    readonly entryId: string
    /** Wait at least this long: a confirmation inside the gap is the same
     *  optical event and is refused by design (D279). */
    readonly afterMs: number
    /** At least this many frames, or the absence can never be confirmed. */
    readonly frames: number
  }) => void

  /** Telemetry callback fired on appear/depart. Best-effort. */
  readonly onChange?: (change: {
    readonly phase: StationaryChangePhase
    readonly entry: StationaryEntry
    /** When the registry CONCLUDED this. For a departure that is deliberately
     *  later than the event itself — see `observedAt`. */
    readonly timestamp: number
    /**
     * When the change was actually OBSERVED — the moment a notification should
     * show, as opposed to the moment we became sure of it.
     *
     * A departure is confirmed by an independent read (D279), and on an
     * on-motion camera the confirming evidence arrives from the periodic
     * occupancy recheck — every 300 s. Measured on device 102: retirements ran
     * 6 to 10 minutes of observed time behind the car actually leaving, and one
     * notification in that window showed an empty space with no car in it,
     * because the media was cut at the moment of CONCLUSION.
     *
     * So the two are separated. `observedAt` is the departing read that armed
     * the strike, or — for a TTL expiry, where no read ever said anything — the
     * last moment the object was confirmed present, which is the last instant
     * anyone can honestly point at.
     */
    readonly observedAt: number
  }) => void
}

export interface StationaryFrameFilterResult {
  /** Detection indices that may not OPEN a track. */
  readonly suppressedIndices: ReadonlySet<number>
  /** The weak subset of `suppressedIndices` the tracker may still use to
   *  CONTINUE a confirmed track (D410). The rest never reach it. */
  readonly continuableIndices: ReadonlySet<number>
  /** Entries confirmed present this frame (for occupancy accounting). */
  readonly confirmed: readonly StationaryConfirmation[]
  /** Entries whose departure was INDEPENDENTLY confirmed → retire them. */
  readonly woken: readonly StationaryWake[]
  /** How many of `suppressedIndices` the D275 reach pass caught (detections on
   *  a parked object that were not its entry's single best match). */
  readonly reachSuppressedCount: number
}

/**
 * One device's departure-strike lifecycle since the last sweep.
 *
 * Rolled into a single line rather than logged per event: arming and cancelling
 * happen on the frame path, and the whole point of D279 is that they should now
 * happen OFTEN and retire nothing. A line each would be the flood.
 */
export interface StationaryStrikeCounters {
  readonly armed: number
  readonly cancelled: number
  readonly expired: number
  readonly warmUpIgnored: number
  readonly wokenByRead: number
  readonly wokenByAbsence: number
  /** Entries that were OVERDUE but held, because the detector had produced
   *  nothing of their class since their last confirmation — a gap in the
   *  detector is not a departure. The number to watch when a camera's census
   *  looks stale: a high count means the detector, not the registry. */
  readonly ttlHeldUnproven: number
  /**
   * WEAK HOLDS THAT WERE STILL, and weak holds that MOVED — the two numbers
   * that decide whether a weak hold may be released to the tracker.
   *
   * Today every weak hold is suppressed from OPENING a track (D275: a parked
   * object must not spawn), and the tracker may only use it to CONTINUE a
   * confirmed one. That is why a passer-by crossing a parked car is never a
   * track of its own — the operator's own complaint, in their words: "tracce
   * che passano momentaneamente vicino a una stazionaria non vengano
   * droppate" [tracks that momentarily pass near a stationary one must not be dropped].
   *
   * The discriminator has to be TIME: a hold that is still, frame after frame,
   * is the parked object; one that moves is somebody walking past it. Which is
   * safe to release depends entirely on the mix, and the mix was never
   * measured — so it is measured here before anything is released. A camera
   * whose weak holds are overwhelmingly `weakStill` can release the moved ones
   * with almost nothing at stake; one where they are mostly `weakMoved` is
   * telling us its anchor is wrong, not that it is busy.
   *
   * Stillness is judged on the CENTROID, not on IoU: a box that flickers in
   * SIZE at night keeps its centre, and judging it by overlap would call the
   * parked object a mover and re-open the D275 leak on exactly the cameras
   * that can least afford it.
   */
  readonly weakStill: number
  readonly weakMoved: number
}

const EMPTY_STRIKE_COUNTERS: StationaryStrikeCounters = {
  armed: 0,
  cancelled: 0,
  ttlHeldUnproven: 0,
  weakStill: 0,
  weakMoved: 0,
  expired: 0,
  warmUpIgnored: 0,
  wokenByRead: 0,
  wokenByAbsence: 0,
}

/** A pending departure, reported for the read-only diagnostic. */
export interface StationaryStrikeView extends DepartureStrike {
  readonly entryId: string
}

/**
 * The mechanics, declared once — see `durable/durable-ledger.ts`.
 *
 * Two things are load-bearing and neither is the primitive's business:
 *
 *  - **`write-behind`.** A promote must not block the frame path on SQLite,
 *    and a lost promote costs one re-discovery of a parked car.
 *  - **No `equalFact`.** This registry never asks "is this the same fact" —
 *    `stationary-match.ts` answers that geometrically, per frame, and hands
 *    down a decision. The primitive is only asked to remember it.
 */
const STATIONARY_SPEC: DurableLedgerSpec<StationaryEntry> = {
  collection: STATIONARY_COLLECTION,
  columns: STATIONARY_COLUMNS,
  indexes: STATIONARY_INDEXES,
  writeMode: 'write-behind',
  keyOf: (entry) => entry.id,
  toValue: entryToValue,
  fromRecord: rowToEntry,
  deviceIdOf: (entry) => entry.deviceId,
}

export class StationaryObjectRegistry {
  /** Entry ids per device — an INDEX over the ledger's mirror, not a second
   *  copy of it. The entries themselves live in exactly one place. */
  private readonly idsByDevice = new Map<number, Set<string>>()
  private readonly ledger: DurableLedger<StationaryEntry>
  private readonly dirty = new Set<string>()
  /** Per entry: the weak reading that keeps agreeing, and since when. RAM only
   *  — a run that does not survive a restart simply starts again, and losing
   *  one costs a second session's worth of weak holds, never a wrong anchor. */
  private readonly weakRuns = new Map<string, WeakRun>()
  private readonly logger: IScopedLogger
  private readonly matchConfig: StationaryMatchConfig
  private readonly entryTtlMs: number
  private readonly departureConfig: StationaryDepartureConfig
  private readonly sessionGapMs: number
  private readonly warmUpMs: number
  private readonly ttlForDevice?: StationaryRegistryDeps['ttlForDevice']
  private readonly onEntryDropped?: StationaryRegistryDeps['onEntryDropped']
  private readonly onChange?: StationaryRegistryDeps['onChange']
  private readonly requestConfirmationLook?: StationaryRegistryDeps['requestConfirmationLook']
  /**
   * When the detector last produced a detection of a given class on a device,
   * ANYWHERE in the frame — whether or not it matched a registry entry.
   *
   * This is the evidence a TTL retirement rests on, and it was missing.
   * `lastFrameAtByDevice` advances on every processed frame, so an entry aged
   * out on frames-flowing time alone: six minutes in which the detector
   * produced no vehicle at all counted exactly like six minutes in which it
   * produced plenty and none of them was this car. The first says nothing
   * about the object; the second says it is gone.
   *
   * Measured on device 102: a motorcycle parked for 29 HOURS was retired by TTL
   * after 6.2 minutes of observed time without a confirmation, while it was
   * still physically there — a debug-flagged track two hours later sat on its
   * exact spot with a median centroid displacement of 0.0 px. Losing the entry
   * loses the suppression, so the object became new again, span a 35-second
   * track with 295 observations and its events, and died before the 120 s the
   * ledger needs to re-promote it. Six retirements in two hours on that one
   * camera, each one a fresh flood.
   */
  private readonly classSeenAt = new Map<number, Map<string, number>>()
  /** Latest processed-frame timestamp per device — expiry counts OBSERVED
   *  time, not wall-clock. A session-dispatch camera produces no frames
   *  between motion sessions; that silence is not evidence the object left,
   *  so quiet minutes must not age the entries (see {@link sweep}). */
  private readonly lastFrameAtByDevice = new Map<number, number>()
  /**
   * Entries carrying ONE unconfirmed departure read, per device (D49, D174,
   * D279).
   *
   * Retiring an entry destroys work — the object's registry identity and the
   * suppression that keeps it from re-spawning a track every promotion window.
   * A single frame whose box slid off the parked spot is a fallible read (a
   * partial occlusion, a shadow, one bad box), so it only ARMS the entry here.
   *
   * The strike is a RECORD, not a bare id, and that is the whole of D279: it
   * carries the instant it was armed, so the confirming read can be required to
   * land far enough away to be a different optical event, and so a strike
   * nobody ever confirmed can decay instead of waiting for an unrelated session
   * minutes later.
   */
  private readonly departureStrikes = new Map<number, Map<string, DepartureStrike>>()
  /**
   * Latest gate-frame time per device, and when the current observation session
   * opened.
   *
   * Kept HERE and not read off {@link lastFrameAtByDevice}: that clock is
   * advanced by `noteFrame`, which the caller invokes AFTER the frame has been
   * processed, so during {@link filter} it still holds the previous frame. The
   * warm-up would work by accident today and break silently the day someone
   * reorders the two calls.
   */
  private readonly lastGateFrameAtByDevice = new Map<number, number>()
  private readonly sessionOpenedAtByDevice = new Map<number, number>()
  private readonly strikeCountersByDevice = new Map<number, StationaryStrikeCounters>()
  /** Detections absorbed by an existing entry since the last sweep, per device.
   *  Rolled up into ONE log line per sweep — this fires on every frame of every
   *  parked object, so it can never be a line of its own. */
  private readonly absorbedSinceSweep = new Map<number, number>()
  /**
   * Detections DROPPED before the tracker since the last sweep, per device, and
   * how many of them the D275 reach pass caught.
   *
   * Counted in {@link filter} because that is the only place the number exists:
   * `applyFrameOutcome` sees confirmations, and a reach-suppressed detection
   * produces no confirmation of its own. Rolled into the SAME per-sweep line as
   * `absorbed` — the event it counts fires on every frame of every parked object
   * (5.9-7.9 fps per camera), so a line per suppressed detection would be its
   * own defect. `reach` is the number that says whether D275 does anything on
   * this camera; if it is 0 for a camera the operator still complains about, the
   * cause is elsewhere.
   */
  private readonly suppressedSinceSweep = new Map<number, number>()
  private readonly reachSuppressedSinceSweep = new Map<number, number>()
  /** Weak holds handed to the tracker as continuable (D410), per device. */
  private readonly continuableSinceSweep = new Map<number, number>()
  /** Of those, the ones the tracker reports actually continued a track. */
  private readonly continuedSinceSweep = new Map<number, number>()

  constructor(deps: StationaryRegistryDeps) {
    this.logger = deps.logger
    this.ledger = new DurableLedger({
      spec: STATIONARY_SPEC,
      kind: deps.records.kind(pipelineAnalyticsRecordKinds['stationary-objects']),
      logger: deps.logger,
    })
    this.matchConfig = deps.matchConfig ?? DEFAULT_MATCH_CONFIG
    this.entryTtlMs = deps.entryTtlMs ?? ENTRY_TTL_MS
    this.departureConfig = deps.departureConfig ?? DEFAULT_DEPARTURE_CONFIG
    this.sessionGapMs = deps.sessionGapMs ?? GATE_SESSION_GAP_MS
    this.warmUpMs = deps.warmUpMs ?? GATE_WARMUP_MS
    this.ttlForDevice = deps.ttlForDevice
    this.onEntryDropped = deps.onEntryDropped
    this.onChange = deps.onChange
    this.requestConfirmationLook = deps.requestConfirmationLook
  }

  /** Hydrate all persisted entries into memory (call once at boot, after
   *  `declare`). Best-effort — a query failure leaves the registry empty. */
  async load(): Promise<void> {
    const entries = await this.ledger.load()
    let purged = 0
    for (const entry of entries) {
      // Self-heal (2026-07-22): a persisted near-full-frame entry is the
      // dawn/night "envelope exploded" box promoted before the promotion
      // gate existed — it squats on the live overlay covering the whole
      // camera. Retire it on hydrate instead of resurrecting it.
      //
      // The same artifact rule a birth is judged by (`isPlausibleStationaryBirthBox`
      // is exactly this call without a score), so a row this hydrate refuses
      // is a row the ledger would refuse to mint today. It is also how the
      // 3836 jacket entry — re-anchored onto a 1094x1406 box on 2026-09-15
      // and blinding the studio to persons for nine hours — was finally
      // removed, on the 06:40 restart of the 16th.
      if (!isPlausibleThumbnailBox(entry.bbox, entry.frameWidth, entry.frameHeight)) {
        purged += 1
        void this.ledger.forget(entry.id)
        continue
      }
      this.indexEntry(entry.deviceId, entry.id)
    }
    this.logger.info('stationary registry loaded', {
      meta: { entries: entries.length, ...(purged > 0 ? { purgedImplausible: purged } : {}) },
    })
  }

  list(deviceId: number): readonly StationaryEntry[] {
    const ids = this.idsByDevice.get(deviceId)
    if (!ids) return []
    const out: StationaryEntry[] = []
    for (const id of ids) {
      const entry = this.ledger.get(id)
      if (entry) out.push(entry)
    }
    return out
  }

  listViews(deviceId: number): readonly StationaryObjectView[] {
    return this.list(deviceId).map(entryToView)
  }

  count(deviceId: number): number {
    return this.idsByDevice.get(deviceId)?.size ?? 0
  }

  /** Device ids that currently hold at least one parked entry — drives the
   *  occupancy baseline sampler (a detached camera with parked cars still
   *  gets a flat history baseline). */
  deviceIds(): readonly number[] {
    const ids: number[] = []
    for (const [deviceId, set] of this.idsByDevice) if (set.size > 0) ids.push(deviceId)
    return ids
  }

  /** Record that a frame was processed for a device — advances the OBSERVED
   *  clock that drives entry expiry in {@link sweep}. */
  noteFrame(deviceId: number, timestamp: number): void {
    const prev = this.lastFrameAtByDevice.get(deviceId) ?? 0
    if (timestamp > prev) this.lastFrameAtByDevice.set(deviceId, timestamp)
  }

  /**
   * Per-frame gate: partition this frame's detections against the device's
   * entries. PURE with respect to ENTRY state — apply the outcome with
   * {@link applyFrameOutcome} once the frame result is assembled.
   *
   * DEPARTURE STRIKES are committed here, not there. They are not entry state:
   * nothing is created, retired or re-anchored by one. Committing them at the
   * decision removes a whole failure shape the caller used to have to remember
   * — `applyFrameOutcome` runs only on a frame with a non-empty outcome, so a
   * frame whose ONLY result was a strike had to be special-cased upstream or
   * the strike was silently dropped.
   */
  filter(
    input: {
      readonly deviceId: number
      readonly detections: readonly StationaryDetectionLike[]
      readonly frameWidth: number
      readonly frameHeight: number
      /** Observed-frame time. Drives strike separation, decay and warm-up. */
      readonly timestamp: number
    },
    config?: StationaryMatchConfig,
  ): StationaryFrameFilterResult {
    const { deviceId, timestamp } = input
    // Session bookkeeping runs even for a device with no entries: it is what
    // makes the FIRST frame after a gap recognisable as a session opening.
    const warmUp = this.noteGateFrame(deviceId, timestamp)
    // WAS THE DETECTOR WORKING? Remembered per class, from every frame, whether
    // or not anything matched an entry — see `classSeenAt` for why a retirement
    // cannot be decided without it.
    this.noteClassesSeen(deviceId, input.detections, timestamp)
    const entries = this.list(deviceId)
    if (entries.length === 0) {
      return {
        suppressedIndices: new Set(),
        continuableIndices: new Set(),
        confirmed: [],
        woken: [],
        reachSuppressedCount: 0,
      }
    }
    const strikes = this.departureStrikes.get(deviceId)
    const result = partitionDetectionsAgainstRegistry({
      entries,
      detections: input.detections,
      // Per-device match config (#31 suppress/wake IoU sliders) overrides the
      // registry-wide default when supplied.
      config: config ?? this.matchConfig,
      now: timestamp,
      departure: this.departureConfig,
      warmUp,
      ...(strikes !== undefined ? { strikes } : {}),
    })
    this.applyStrikeChanges(deviceId, result.strikeChanges)
    if (result.warmUpDepartureReads > 0) {
      this.bumpStrikeCounters(deviceId, { warmUpIgnored: result.warmUpDepartureReads })
    }
    for (const wake of result.woken) {
      this.bumpStrikeCounters(
        deviceId,
        wake.cause === 'contradicting-read' ? { wokenByRead: 1 } : { wokenByAbsence: 1 },
      )
    }
    // A branch that drops work must never be silent. Counted here, reported once
    // per device per sweep in {@link sweep}.
    if (result.suppressedIndices.size > 0) {
      this.suppressedSinceSweep.set(
        deviceId,
        (this.suppressedSinceSweep.get(deviceId) ?? 0) + result.suppressedIndices.size,
      )
      if (result.reachSuppressedCount > 0) {
        this.reachSuppressedSinceSweep.set(
          deviceId,
          (this.reachSuppressedSinceSweep.get(deviceId) ?? 0) + result.reachSuppressedCount,
        )
      }
      if (result.continuableIndices.size > 0) {
        this.continuableSinceSweep.set(
          deviceId,
          (this.continuableSinceSweep.get(deviceId) ?? 0) + result.continuableIndices.size,
        )
      }
    }
    return {
      suppressedIndices: result.suppressedIndices,
      continuableIndices: result.continuableIndices,
      confirmed: result.confirmed,
      woken: result.woken,
      reachSuppressedCount: result.reachSuppressedCount,
    }
  }

  /** The tracker's answer to {@link StationaryFrameFilterResult.continuableIndices}:
   *  how many of this frame's weak holds continued a confirmed track (D410).
   *  Counted here so the sweep line can report it beside `continuable`. */
  noteContinued(deviceId: number, count: number): void {
    if (count <= 0) return
    this.continuedSinceSweep.set(deviceId, (this.continuedSinceSweep.get(deviceId) ?? 0) + count)
  }

  /** Pending departure strikes for a device — the read-only diagnostic's whole
   *  reason to exist. Ordered oldest first so "what has been waiting" reads
   *  straight off the top. */
  strikesFor(deviceId: number): readonly StationaryStrikeView[] {
    const strikes = this.departureStrikes.get(deviceId)
    if (strikes === undefined) return []
    return [...strikes]
      .map(([entryId, strike]) => ({ entryId, ...strike }))
      .toSorted((a, b) => a.armedAt - b.armedAt)
  }

  /** When the device's current observation session opened, if one has. */
  sessionOpenedAt(deviceId: number): number | undefined {
    return this.sessionOpenedAtByDevice.get(deviceId)
  }

  /** The device's OBSERVED clock — its latest processed frame. Every age this
   *  registry reasons about is measured against it, never against wall time. */
  observedAt(deviceId: number): number | undefined {
    return this.lastFrameAtByDevice.get(deviceId)
  }

  /** Fold a frame's gate result back into state: advance confirmed entries'
   *  `lastConfirmedAt` and retire woken entries (their object departed).
   *
   *  A confirmation is STAGED, not persisted: it happens on every frame, and
   *  the sweep flushes it (see the primitive's `stage` docblock for the cost). */
  applyFrameOutcome(input: {
    readonly deviceId: number
    readonly confirmed: readonly StationaryConfirmation[]
    readonly woken: readonly StationaryWake[]
    readonly timestamp: number
  }): void {
    const ids = this.idsByDevice.get(input.deviceId)
    if (!ids) return
    for (const c of input.confirmed) {
      if (!ids.has(c.entryId)) continue
      const e = this.ledger.get(c.entryId)
      if (!e) continue
      // RE-ANCHOR on an unambiguous read (D174). The reference box used to be
      // frozen at the promotion instant forever, so the object's own slow drift
      // eventually walked its centroid out of a box that no longer described
      // it — and that read as a departure. An entry that follows its object
      // cannot accumulate that error. A weak (jitter) read is a real
      // confirmation but a bad anchor, so it only advances the clock.
      //
      // …UNLESS the weak read keeps saying the same thing. An anchor inflated
      // at promotion (102's `02e6bf01`: 406x1103 staged from a merged frame,
      // against a real 399x814 — IoU 0.58 on a 0.60 bar) makes EVERY reading of
      // its object weak, for ever, and "a weak hold never re-anchors" leaves
      // nothing that can correct it. See `stale-anchor.ts` for what that cost.
      let bbox = c.strong ? { ...c.observedBbox } : undefined
      if (c.strong) {
        this.weakRuns.delete(c.entryId)
      } else {
        const step = stepStaleAnchor(
          this.weakRuns.get(c.entryId),
          c.observedBbox,
          input.timestamp,
          undefined,
          // The box this correction would REPLACE. Without it, patience alone
          // let a person standing in front of an entry for 30 s take its
          // anchor — measured on Camera studio within an hour of this
          // shipping: 236x568 became 1094x1406, at IoU 0.087.
          e.bbox,
        )
        if (step.kind === 'hold') this.weakRuns.set(c.entryId, step.run)
        else this.weakRuns.delete(c.entryId)
        // The mix that decides whether a moved weak hold may be released to
        // the tracker — see `weakStill` / `weakMoved`.
        this.bumpStrikeCounters(
          input.deviceId,
          step.kind === 'reset' ? { weakMoved: 1 } : { weakStill: 1 },
        )
        if (step.kind === 'reanchor') {
          bbox = { ...step.bbox }
          // Rare by construction — once per bad anchor — and it changes what
          // the entry IS, so it is never silent.
          this.logger?.info('stationary entry re-anchored — the weak read kept agreeing', {
            tags: { deviceId: input.deviceId },
            meta: {
              entryId: c.entryId,
              className: e.className,
              from: e.bbox,
              to: step.bbox,
            },
          })
        }
      }
      this.ledger.stage({
        ...e,
        lastConfirmedAt: input.timestamp,
        ...(bbox !== undefined ? { bbox } : {}),
      })
      this.dirty.add(c.entryId)
    }
    this.absorbedSinceSweep.set(
      input.deviceId,
      (this.absorbedSinceSweep.get(input.deviceId) ?? 0) + input.confirmed.length,
    )
    for (const wake of input.woken) {
      if (!ids.has(wake.entryId)) continue
      const e = this.ledger.get(wake.entryId)
      if (!e) continue
      this.dropEntry(input.deviceId, wake.entryId)
      // A retirement re-opens the object to normal tracking: it will be re-born
      // as a moving track and re-promoted. That used to happen with no log line
      // at all, so an operator saw only the promotions and had no way to ask
      // why. Retirements are rare (a live camera produces tens per DAY), so
      // this is one line each, always tagged with the device.
      //
      // `cause` and `strikeAgeMs` are what the next audit needs: they say WHICH
      // of the two independent confirmations fired and how far it landed from
      // the arming read. The retirements that produced D279 would have been
      // recognisable on sight with a `strikeAgeMs` of 900 in them.
      this.logger.info('stationary entry retired', {
        tags: { deviceId: input.deviceId },
        meta: {
          deviceId: input.deviceId,
          entryId: wake.entryId,
          className: e.className,
          reason: 'departed',
          cause: wake.cause,
          strikeAgeMs: wake.strikeAgeMs,
          absentReads: wake.absentReads,
          parkedForMs: input.timestamp - e.becameStationaryAt,
          ...(e.sourceTrackId !== undefined ? { sourceTrackId: e.sourceTrackId } : {}),
        },
      })
      this.onChange?.({
        phase: 'departed',
        entry: e,
        timestamp: input.timestamp,
        // The departing read that armed the strike. The registry already knows
        // how old the strike was — that age IS the independence the retirement
        // rests on — so the moment costs nothing to carry.
        observedAt: input.timestamp - wake.strikeAgeMs,
      })
    }
  }

  /**
   * Promote a parked track into a persisted stationary entry — or, when the
   * spot is already censused, CONFIRM the entry sitting on it.
   *
   * The occupancy question is asked here and nowhere else, with the same
   * predicate the per-frame filter uses (`findParkedOccupant`): a box the
   * filter would suppress as a parked object's own can never become a second
   * parked object. Until 2026-09-14 this method minted whatever it was handed,
   * and device 102 reported EIGHT parked vehicles — four of them one car, the
   * same box to the decimal, promoted again roughly once an hour because the
   * weak-continuation path (D410) keeps feeding the ledger from a track riding
   * a parked object. The re-promotion is not the anomaly and is not worth
   * suppressing: it is a fresh, independent confirmation that the thing is
   * still there. It just must not produce a neighbour.
   *
   * A merge never DOWNGRADES the tenant: it advances the clock and adopts an
   * identity the tenant lacks (the 102 duplicates arrived unlabelled while the
   * row they belonged to was already `Car`), and it never overwrites one it
   * has.
   */
  async promote(
    entry: StationaryEntry,
    config?: StationaryMatchConfig,
  ): Promise<StationaryPromotion> {
    // The predicate is the filter's own, so an OVERSIZE tenant (≥
    // `OVERSIZE_AREA_FRAC`) holds a candidate on a strong read only and can
    // never absorb a neighbour as a "fragment" — the D495 motorcycle loss —
    // without a second list of who may absorb (D508).
    const occupant = findParkedOccupant(
      this.list(entry.deviceId),
      entry.className,
      entry.bbox,
      (config ?? this.matchConfig).suppressIou,
      (config ?? this.matchConfig).wakeAssocIou,
    )
    if (occupant !== undefined) {
      const merged = this.absorbInto(occupant, entry)
      // A branch that ACCEPTS work and produces no row of its own says so
      // (D391). Per merge, not rolled up: a spot that absorbs a promotion every
      // hour is the signature of a track riding a parked object, and that is
      // worth reading per camera.
      this.logger.info('stationary promotion absorbed — the spot is already censused', {
        tags: { deviceId: occupant.deviceId },
        meta: {
          deviceId: occupant.deviceId,
          entryId: occupant.id,
          className: occupant.className,
          refusedTrackId: entry.sourceTrackId,
          parkedForMs: entry.becameStationaryAt - occupant.becameStationaryAt,
          gainedLabel: occupant.label === undefined && entry.label !== undefined,
        },
      })
      return { outcome: 'merged', entry: merged }
    }
    this.indexEntry(entry.deviceId, entry.id)
    this.dirty.delete(entry.id)
    // `put` on a write-behind ledger mirrors first and swallows the store
    // error into a logged warning — the frame path never sees it.
    await this.ledger.put(entry)
    this.onChange?.({
      phase: 'appeared',
      entry,
      timestamp: entry.becameStationaryAt,
      // A birth is concluded at the moment it is observed: the promotion
      // happens on the frame that earned it.
      observedAt: entry.becameStationaryAt,
    })
    return { outcome: 'born', entry }
  }

  /** Fold a refused promotion into the entry that already holds its spot. */
  private absorbInto(occupant: StationaryEntry, refused: StationaryEntry): StationaryEntry {
    const merged: StationaryEntry = {
      ...occupant,
      lastConfirmedAt: Math.max(occupant.lastConfirmedAt, refused.becameStationaryAt),
      ...(occupant.label === undefined && refused.label !== undefined
        ? { label: refused.label }
        : {}),
      ...(occupant.keyFrameMediaId === undefined && refused.keyFrameMediaId !== undefined
        ? { keyFrameMediaId: refused.keyFrameMediaId }
        : {}),
    }
    this.ledger.stage(merged)
    this.dirty.add(merged.id)
    return merged
  }

  /**
   * Does THIS node analyse `deviceId`?
   *
   * The registry's ownership signal, and the only one it has: a node receives
   * inference frames for the cameras it analyses and for no others, so an
   * observed clock ({@link noteFrame}) is the fact "this camera is mine". It is
   * the same authority the summary sealer uses (`analysedDeviceIds` off
   * `lastFrameDimsByDevice`, 2026-09-13, for the same defect on the same
   * shared table), and it is never cleared per-device, so an idle camera stays
   * ours and a camera we have never framed never becomes ours by accident.
   *
   * What it deliberately is NOT: a per-camera node assignment. `addon-post-
   * analysis` has none — post-processing is a cluster singleton chosen by
   * `postProcessingNodeState`, which the registry cannot see and which says
   * nothing per camera. A node that analyses nothing observes nothing, so this
   * predicate answers `false` for every row it hydrated, which is the outcome
   * the singleton would have produced.
   */
  private analyses(deviceId: number): boolean {
    return this.lastFrameAtByDevice.has(deviceId)
  }

  /**
   * Retire entries unconfirmed for longer than the TTL of OBSERVED time,
   * collapse duplicate rows, and flush any advanced `lastConfirmedAt`s to the
   * store. Returns retired entries (for logging).
   *
   * ONLY for the cameras this node analyses ({@link analyses}). Every node runs
   * this addon and every node hydrates the SAME table in {@link load}, so a
   * sweep over every hydrated device judges — and mutates — cameras it has no
   * frames for. Measured 2026-09-14: the duplicate collapse for device 102 was
   * logged by `MacMiniAgent.localdomain` and by `agent-a`, the same
   * rows, seven seconds apart.
   *
   * Expiry is measured against the device's latest processed-frame timestamp
   * ({@link noteFrame}), NOT the wall clock: a session-dispatch camera emits
   * no frames between motion sessions, and that silence says nothing about
   * the object. Only when the camera has actually been WATCHING for `ttl`
   * beyond the last confirmation (frames flowed, object never matched) is the
   * object considered removed. A device with no recorded frame yet never
   * expires its entries. `now` only stamps the departed telemetry.
   */
  async sweep(now: number): Promise<readonly StationaryEntry[]> {
    const retired: StationaryEntry[] = []
    let foreign = 0
    for (const [deviceId, ids] of this.idsByDevice) {
      const observedAt = this.lastFrameAtByDevice.get(deviceId)
      // Not ours (see the docblock): no observed clock means this node has
      // never framed this camera, so it knows nothing about it and may not
      // judge it. This was already the TTL rule by accident — an entry with no
      // observed clock cannot age — and is now the rule for the whole sweep.
      if (observedAt === undefined) {
        foreign += 1
        continue
      }
      // Per-device TTL (#31) resolved live; falls back to the registry default.
      const ttl = this.ttlForDevice?.(deviceId) ?? this.entryTtlMs
      for (const id of [...ids]) {
        const e = this.ledger.get(id)
        if (!e) {
          ids.delete(id)
          continue
        }
        const overdue = observedAt - e.lastConfirmedAt > ttl
        // A TTL RETIREMENT NEEDS THE DETECTOR TO HAVE PROVED ITSELF.
        //
        // Being overdue is a clock, not evidence. The departure path already
        // knows this — it retires on `sustained-absence` only after N reads in
        // which something WAS being seen and this object was not (D279). The
        // TTL had no such requirement: it counted frames, and a detector that
        // produced nothing looked exactly like an object that had left.
        //
        // So the same class must have been detected somewhere on this camera
        // since the entry was last confirmed. If it has, the silence is about
        // THIS object. If it has not, the silence is about the detector, and
        // retiring costs the suppression that stops the object re-spawning.
        const proven = this.detectorProvedItself(e)
        // The backstop. Without one an object that vanished while its whole
        // class stopped being detected would be immortal — the strike path
        // needs a departing READ to arm, which never comes if nothing is
        // detected at all. Twelve TTLs of observed time (one hour at the
        // default) is far past any detector gap this fleet produces, and it
        // retires under its own reason so the two are never confused in a log.
        const unprovenBackstop = observedAt - e.lastConfirmedAt > ttl * 12
        if (overdue && !proven && !unprovenBackstop) {
          this.bumpStrikeCounters(deviceId, { ttlHeldUnproven: 1 })
          continue
        }
        if (overdue) {
          this.dropEntry(deviceId, id)
          retired.push(e)
          // Same contract as the wake path: a retirement is never silent. The
          // caller discards the return value, so the line belongs here.
          this.logger.info('stationary entry retired', {
            tags: { deviceId },
            meta: {
              deviceId,
              entryId: id,
              className: e.className,
              reason: proven ? 'ttl' : 'ttl-unproven',
              ttlMs: ttl,
              unconfirmedForMs: observedAt - e.lastConfirmedAt,
              parkedForMs: observedAt - e.becameStationaryAt,
            },
          })
          // A TTL expiry: nothing ever READ a departure, the entry simply
          // stopped being confirmed. The last honest moment is the last
          // confirmation — after it, we know only that it went, not when.
          this.onChange?.({
            phase: 'departed',
            entry: e,
            timestamp: now,
            observedAt: e.lastConfirmedAt,
          })
        }
      }
      if (ids.size === 0) this.idsByDevice.delete(deviceId)
    }
    if (foreign > 0) {
      // Not a drop: another node owns these cameras and sweeps them. Debug,
      // because on a node that analyses nothing this fires every five minutes
      // for the whole fleet.
      this.logger.debug('stationary sweep skipped cameras this node does not analyse', {
        meta: { devices: foreign },
      })
    }
    // The absorption counter — how much track churn the registry actually
    // prevented since the last sweep. One line per device per sweep; the event
    // it counts happens on every frame of every parked object.
    //
    // `suppressed` is the number the operator's complaint is about: detections
    // DROPPED before the tracker. `reach` is the D275 slice of it — detections
    // that were on a parked object but not its best match, which used to reach
    // the tracker and open a track. A camera reporting tracks on parked cars
    // with `reach: 0` is a camera whose leak is somewhere else.
    const countedDevices = new Set([
      ...this.absorbedSinceSweep.keys(),
      ...this.suppressedSinceSweep.keys(),
    ])
    for (const deviceId of countedDevices) {
      const absorbed = this.absorbedSinceSweep.get(deviceId) ?? 0
      const suppressed = this.suppressedSinceSweep.get(deviceId) ?? 0
      if (absorbed === 0 && suppressed === 0) continue
      this.logger.info('stationary registry absorbed detections', {
        tags: { deviceId },
        meta: {
          deviceId,
          absorbed,
          suppressed,
          reach: this.reachSuppressedSinceSweep.get(deviceId) ?? 0,
          // D410: `continuable` is the weak slice of `suppressed` the tracker
          // was allowed to continue a confirmed track with; `continued` is how
          // many did. `suppressed − continuable` never reached the tracker.
          continuable: this.continuableSinceSweep.get(deviceId) ?? 0,
          continued: this.continuedSinceSweep.get(deviceId) ?? 0,
          entries: this.count(deviceId),
        },
      })
    }
    this.absorbedSinceSweep.clear()
    this.suppressedSinceSweep.clear()
    this.reachSuppressedSinceSweep.clear()
    this.continuableSinceSweep.clear()
    this.continuedSinceSweep.clear()
    // The departure-strike lifecycle (D279). Every field here is an event on
    // the frame path, so none of them can be a line of its own — and every one
    // of them is a decision that either destroyed an entry or refused to.
    // `armed` far above `woken*` is the mechanism working: reads that used to
    // retire a parked car now arm and are cancelled.
    for (const [deviceId, counters] of this.strikeCountersByDevice) {
      this.logger.info('stationary departure strikes', {
        tags: { deviceId },
        meta: {
          deviceId,
          armed: counters.armed,
          cancelled: counters.cancelled,
          expired: counters.expired,
          warmUpIgnored: counters.warmUpIgnored,
          wokenByRead: counters.wokenByRead,
          wokenByAbsence: counters.wokenByAbsence,
          // Overdue entries the registry REFUSED to retire because the detector
          // had gone quiet. A high number here means the detector, not the
          // census.
          ttlHeldUnproven: counters.ttlHeldUnproven,
          // The mix that decides whether a MOVED weak hold may be released to
          // the tracker, so a passer-by near a parked car gets its own track
          // instead of being swallowed by the suppression that exists to stop
          // the parked car spawning one. Judged on the CENTROID: a box that
          // flickers in size at night keeps its centre, and judging by overlap
          // would call the parked object a mover and re-open the D275 leak on
          // the cameras that can least afford it.
          weakStill: counters.weakStill,
          weakMoved: counters.weakMoved,
          pending: this.departureStrikes.get(deviceId)?.size ?? 0,
        },
      })
    }
    this.strikeCountersByDevice.clear()
    // ONE SPOT, ONE ROW — as an invariant, not only as a birth-time check.
    // The birth guard stops a duplicate being CREATED; it cannot remove one
    // already written, and a duplicate cannot expire on its own: every row on
    // the spot is confirmed by the same detection every frame, so all of them
    // stay alive for exactly as long as the object does. Device 102 held four
    // rows for one car, all four re-confirmed by the same frame, and they would
    // have survived until the car drove away.
    //
    // Only for the cameras THIS node analyses, exactly like the TTL pass above.
    // On 2026-09-14 the 102 collapse was logged by `MacMiniAgent.localdomain`
    // AND by `agent-a`, the same rows and the same entry ids, seven
    // seconds apart — every node hydrates the shared table in {@link load} and
    // was then judging every camera in the cluster with its own view.
    for (const deviceId of [...this.idsByDevice.keys()]) {
      if (!this.analyses(deviceId)) continue
      this.collapseDuplicates(deviceId)
    }
    // Flush staged lastConfirmedAt for entries still present.
    for (const id of [...this.dirty]) {
      this.dirty.delete(id)
      const entry = this.ledger.get(id)
      if (!entry) continue
      await this.ledger.put(entry)
    }
    return retired
  }

  /** Drop a device's entries from memory WITHOUT deleting persisted rows.
   *  Used on device unbind; a rebind reloads from the store. */
  forgetDevice(deviceId: number): void {
    this.lastFrameAtByDevice.delete(deviceId)
    this.classSeenAt.delete(deviceId)
    this.departureStrikes.delete(deviceId)
    this.lastGateFrameAtByDevice.delete(deviceId)
    this.sessionOpenedAtByDevice.delete(deviceId)
    this.strikeCountersByDevice.delete(deviceId)
    this.absorbedSinceSweep.delete(deviceId)
    this.suppressedSinceSweep.delete(deviceId)
    this.reachSuppressedSinceSweep.delete(deviceId)
    const ids = this.idsByDevice.get(deviceId)
    if (!ids) return
    for (const id of ids) {
      this.dirty.delete(id)
      this.weakRuns.delete(id)
      this.ledger.evict(id)
    }
    this.idsByDevice.delete(deviceId)
  }

  /** Delete every persisted + in-memory entry for a device (operator wipe). */
  async clearDevice(deviceId: number): Promise<void> {
    this.lastFrameAtByDevice.delete(deviceId)
    this.departureStrikes.delete(deviceId)
    this.lastGateFrameAtByDevice.delete(deviceId)
    this.sessionOpenedAtByDevice.delete(deviceId)
    this.strikeCountersByDevice.delete(deviceId)
    this.absorbedSinceSweep.delete(deviceId)
    this.suppressedSinceSweep.delete(deviceId)
    this.reachSuppressedSinceSweep.delete(deviceId)
    const ids = this.idsByDevice.get(deviceId)
    if (ids) {
      for (const id of [...ids]) {
        this.dirty.delete(id)
        void this.ledger.forget(id)
      }
      this.idsByDevice.delete(deviceId)
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Advance the gate clock and answer "is this frame inside the warm-up?".
   *
   * A gap wider than {@link sessionGapMs} means a NEW observation session, and
   * the warm-up restarts because the frames after an open come off a cold
   * decoder.
   *
   * It deliberately does NOT clear the pending strikes. That was the first
   * shape of this fix and it was a second mechanism doing the first one's job:
   * a strike decays after `strikeTtlMs` (30 s), the sessions this camera
   * produces are minutes apart, so by the first frame of the next session every
   * carried strike is already expired — and the ONE case a session boundary
   * would additionally have caught (two sessions a handful of seconds apart) is
   * a confirmation that is genuinely independent in time and lands on a decoder
   * the warm-up has already vouched for.
   */
  private noteGateFrame(deviceId: number, timestamp: number): boolean {
    const prev = this.lastGateFrameAtByDevice.get(deviceId)
    this.lastGateFrameAtByDevice.set(deviceId, timestamp)
    // `timestamp < prev` is a clock that went backwards (a replay, a reordered
    // frame). Treated as an open rather than as a negative gap, because a
    // negative gap would silently keep a warm-up that describes other pixels.
    const opened = prev === undefined || timestamp < prev || timestamp - prev > this.sessionGapMs
    if (opened) this.sessionOpenedAtByDevice.set(deviceId, timestamp)
    const openedAt = this.sessionOpenedAtByDevice.get(deviceId) ?? timestamp
    return timestamp - openedAt < this.warmUpMs
  }

  /** Commit the frame's strike transitions. A `null` strike removes it. */
  private applyStrikeChanges(deviceId: number, changes: readonly DepartureStrikeChange[]): void {
    if (changes.length === 0) return
    let pending = this.departureStrikes.get(deviceId)
    for (const change of changes) {
      if (change.strike === null) {
        pending?.delete(change.entryId)
        if (change.reason === 'expired') {
          this.bumpStrikeCounters(deviceId, { expired: 1 })
          this.logger.debug('stationary departure strike expired unconfirmed', {
            tags: { deviceId },
            meta: {
              deviceId,
              entryId: change.entryId,
              strikeTtlMs: this.departureConfig.strikeTtlMs,
            },
          })
          continue
        }
        this.bumpStrikeCounters(deviceId, { cancelled: 1 })
        this.logger.debug('stationary departure strike cancelled by a re-confirmation', {
          tags: { deviceId },
          meta: { deviceId, entryId: change.entryId, reason: change.reason },
        })
        continue
      }
      if (pending === undefined) {
        pending = new Map()
        this.departureStrikes.set(deviceId, pending)
      }
      pending.set(change.entryId, change.strike)
      if (change.reason === 'armed') {
        this.bumpStrikeCounters(deviceId, { armed: 1 })
        this.logger.debug('stationary departure strike armed', {
          tags: { deviceId },
          meta: {
            deviceId,
            entryId: change.entryId,
            confirmMinGapMs: this.departureConfig.confirmMinGapMs,
          },
        })
        // ASK FOR A LOOK, because in a moment there will be nobody looking.
        //
        // A strike is armed by a departing read during a motion session — and
        // the session is ending, because the thing that was moving has gone.
        // The confirmation then needs `absenceMinReads` frames that will never
        // arrive: the strike decays after `strikeTtlMs` (30 s) and the next
        // periodic recheck is up to 300 s away. Measured on 102, every
        // departure but one was settled by the entry ageing out 6-10 minutes of
        // observed time later.
        //
        // The ask is deliberately shaped by the two numbers that refuse it
        // otherwise: it is DELAYED past `confirmMinGapMs`, because a read
        // inside that window is the same optical event and D279 rejects it by
        // design; and it asks for at least `absenceMinReads` frames, because
        // the recheck's own default is FOUR and an absence needs five — which
        // is why a single burst could never confirm one.
        this.requestConfirmationLook?.({
          deviceId,
          entryId: change.entryId,
          afterMs: this.departureConfig.confirmMinGapMs,
          frames: this.departureConfig.absenceMinReads,
        })
      }
    }
    if (pending !== undefined && pending.size === 0) this.departureStrikes.delete(deviceId)
  }

  /** Fold a delta into a device's strike counters, replacing the record rather
   *  than mutating it. */
  private bumpStrikeCounters(deviceId: number, delta: Partial<StationaryStrikeCounters>): void {
    const cur = this.strikeCountersByDevice.get(deviceId) ?? EMPTY_STRIKE_COUNTERS
    this.strikeCountersByDevice.set(deviceId, {
      armed: cur.armed + (delta.armed ?? 0),
      cancelled: cur.cancelled + (delta.cancelled ?? 0),
      expired: cur.expired + (delta.expired ?? 0),
      warmUpIgnored: cur.warmUpIgnored + (delta.warmUpIgnored ?? 0),
      weakStill: cur.weakStill + (delta.weakStill ?? 0),
      weakMoved: cur.weakMoved + (delta.weakMoved ?? 0),
      wokenByRead: cur.wokenByRead + (delta.wokenByRead ?? 0),
      wokenByAbsence: cur.wokenByAbsence + (delta.wokenByAbsence ?? 0),
      ttlHeldUnproven: cur.ttlHeldUnproven + (delta.ttlHeldUnproven ?? 0),
    })
  }

  private indexEntry(deviceId: number, id: string): void {
    let set = this.idsByDevice.get(deviceId)
    if (!set) {
      set = new Set()
      this.idsByDevice.set(deviceId, set)
    }
    set.add(id)
  }

  /** Retire one entry: index, staged advance, pending strike and durable row
   *  all go. A strike that outlived its entry would arm the NEXT entry to reuse
   *  the id — the registry mints UUIDs, but the invariant is cheap to keep. */
  /**
   * Fold every row that holds another row's spot into the OLDEST of them.
   *
   * The survivor is the oldest because it is the one carrying the object's real
   * `becameStationaryAt` — "parked since 14:30" is the fact the operator reads,
   * and the duplicates are all later re-discoveries of the same thing. It
   * inherits any identity the losers carry and that it lacks, and the losers'
   * rows are deleted outright: a retirement would announce a departure that
   * never happened.
   *
   * Uses the same predicate as the filter and the birth guard, so a collapse
   * can only ever remove a row that could not have been independently confirmed
   * anyway.
   */
  private collapseDuplicates(deviceId: number): void {
    const entries = [...this.list(deviceId)].sort(
      (a, b) => a.becameStationaryAt - b.becameStationaryAt,
    )
    if (entries.length < 2) return
    const survivors: StationaryEntry[] = []
    for (const candidate of entries) {
      const occupant = findParkedOccupant(
        survivors,
        candidate.className,
        candidate.bbox,
        this.matchConfig.suppressIou,
        this.matchConfig.wakeAssocIou,
      )
      if (occupant === undefined) {
        survivors.push(candidate)
        continue
      }
      const merged = this.absorbInto(occupant, candidate)
      survivors[survivors.indexOf(occupant)] = merged
      this.dropEntry(deviceId, candidate.id)
      this.logger.info('stationary duplicate collapsed — two rows, one spot', {
        tags: { deviceId },
        meta: {
          deviceId,
          keptEntryId: occupant.id,
          droppedEntryId: candidate.id,
          className: candidate.className,
          keptSinceMs: occupant.becameStationaryAt,
          droppedSinceMs: candidate.becameStationaryAt,
        },
      })
    }
  }

  /** Fold this frame's classes into {@link classSeenAt}. */
  private noteClassesSeen(
    deviceId: number,
    detections: readonly StationaryDetectionLike[],
    timestamp: number,
  ): void {
    if (detections.length === 0) return
    let seen = this.classSeenAt.get(deviceId)
    if (seen === undefined) {
      seen = new Map()
      this.classSeenAt.set(deviceId, seen)
    }
    for (const d of detections) seen.set(normaliseStationaryClass(d.className), timestamp)
  }

  /**
   * Has the detector produced this entry's class since the entry was last
   * confirmed? `undefined` when nothing of that class has EVER been seen on the
   * device — which is also not evidence.
   */
  private detectorProvedItself(entry: StationaryEntry): boolean {
    const at = this.classSeenAt.get(entry.deviceId)?.get(normaliseStationaryClass(entry.className))
    return at !== undefined && at > entry.lastConfirmedAt
  }

  private dropEntry(deviceId: number, id: string): void {
    const dropped = this.ledger.get(id)
    this.idsByDevice.get(deviceId)?.delete(id)
    this.dirty.delete(id)
    this.weakRuns.delete(id)
    const armed = this.departureStrikes.get(deviceId)
    if (armed) {
      armed.delete(id)
      if (armed.size === 0) this.departureStrikes.delete(deviceId)
    }
    void this.ledger.forget(id)
    // After the index no longer lists it, so a release that re-reads the
    // registry sees the entry gone and never spares its own key frame.
    if (dropped !== undefined) this.onEntryDropped?.(dropped)
  }
}

/** The persisted column map for an entry (the `id` PK is passed separately). */
function entryToValue(e: StationaryEntry): Record<string, unknown> {
  return {
    deviceId: e.deviceId,
    className: e.className,
    bbox: { ...e.bbox },
    frameWidth: e.frameWidth,
    frameHeight: e.frameHeight,
    firstSeenAt: e.firstSeenAt,
    becameStationaryAt: e.becameStationaryAt,
    lastConfirmedAt: e.lastConfirmedAt,
    ...(e.sourceTrackId !== undefined ? { sourceTrackId: e.sourceTrackId } : {}),
    ...(e.label !== undefined ? { label: e.label } : {}),
    ...(e.keyFrameMediaId !== undefined ? { keyFrameMediaId: e.keyFrameMediaId } : {}),
  }
}

function rowToEntry(id: string, data: Record<string, unknown>): StationaryEntry | null {
  const deviceId = Number(data['deviceId'])
  const className = data['className']
  const bbox = data['bbox'] as StationaryEntry['bbox'] | null | undefined
  if (!Number.isFinite(deviceId) || typeof className !== 'string' || !bbox) return null
  const sourceTrackId = data['sourceTrackId']
  const label = data['label']
  // A measurement that failed is absent, never zero (D393) — Number(undefined)
  // is NaN, which Number.isFinite correctly rejects.
  const keyFrameMediaId = Number(data['keyFrameMediaId'])
  return {
    id,
    deviceId,
    className,
    bbox: { x: Number(bbox.x), y: Number(bbox.y), w: Number(bbox.w), h: Number(bbox.h) },
    frameWidth: Number(data['frameWidth'] ?? 0),
    frameHeight: Number(data['frameHeight'] ?? 0),
    firstSeenAt: Number(data['firstSeenAt'] ?? 0),
    becameStationaryAt: Number(data['becameStationaryAt'] ?? 0),
    lastConfirmedAt: Number(data['lastConfirmedAt'] ?? 0),
    ...(typeof sourceTrackId === 'string' ? { sourceTrackId } : {}),
    ...(typeof label === 'string' ? { label } : {}),
    ...(Number.isFinite(keyFrameMediaId) ? { keyFrameMediaId } : {}),
  }
}
