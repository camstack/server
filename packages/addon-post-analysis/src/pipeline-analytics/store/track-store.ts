/**
 * TrackStore — unified in-memory state + persisted history for tracked
 * objects. Active tracks (within TTL) live in RAM only; expired tracks
 * are written to the declared `tracks` collection for historical review
 * (UI timeline, forensic queries).
 *
 * Per the user's direction (P4 design): active tracks are never
 * persisted on cold-start — if the hub restarts, the tracker starts
 * fresh and the analysis pipeline picks up new tracks from the next
 * frame. Historical completed tracks stay queryable forever (subject to
 * retention).
 */

import type {
  IScopedLogger,
  LabelAttribution,
  LabelTier,
  RetrainStatus,
  SettingsStoreClient,
  Track,
  TrackFlagsPatch,
  TrackProjection,
  TrackSource,
  TrackState,
  TrackZoneFilter,
} from '@camstack/types'
import { RetrainStatusSchema, TrackPlacementSchema, TrackSourceSchema } from '@camstack/types'
import {
  displayLabel,
  type LabelCandidate,
  resolveTieredLabelWrite,
  type TieredLabelDecision,
  type TieredLabelPatch,
  type TieredLabelState,
} from '../pipeline/label-tier.js'
import { canRollbackSnapshot, type SnapshotPendingMark } from '../pipeline/snapshot-retry.js'
import { ClosedRowMediaGate } from '../pipeline/closed-row-media-gate.js'
import type { ParkedProbeTrack } from '../pipeline/track-close.js'
import { TTL_SWEEP_INTERVAL_MS, type SweptTrack } from '../pipeline/tracker-sweep.js'
import { LINK_WINDOW_MS } from '../pipeline/tracker-v2/constants.js'
import type { ResolvedTrackFlags } from '../pipeline/track-flags.js'
import { AUDIO_TRACK_CLASS, normalizeAudioTrackClass } from './audio-track-class.js'
import { decodePositions, encodePositions, geometryOnlyPositions } from './position-codec.js'
import {
  compareRecentDesc,
  decodeRecentCursor,
  encodeRecentCursor,
  isAfterCursor,
} from './recent-cursor.js'
import {
  isShortMotionlessTrack,
  netDisplacementPx,
  isDiscardExemptClass,
} from './short-motionless.js'
import { readTieredLabelColumns, tieredLabelColumnData } from './tiered-label-columns.js'
import type { TrackProvenance } from '../pipeline/track-provenance.js'
import type { TrackPlacement } from '../pipeline/track-placement.js'
import { trackSourceFilter } from './track-source-filter.js'
import {
  EMPTY_MOVED_PROBE,
  type MovedProbe,
  type PromotionPlan,
  planFromMoved,
  probeMoved,
  stepMovedProbe,
} from '../pipeline/stationary/promotion-plan.js'
import { computeTrackEnvelope, positionsIntersectZone, zoneBounds } from './zone-geometry.js'
import { mergeActiveTracks } from './track-merge.js'

/**
 * WHY a track's row was written EARLY — i.e. by {@link TrackStore.closeActive}
 * rather than by the ordinary TTL expiry.
 *
 * `'stationary-promotion'` is the only member and means: the tracker decided
 * this subject had PARKED, handed it to the stationary registry, and the row
 * was written so its media, events and vector keep an owner (D161). It is not a
 * quality signal — and since 2026-08-15 it is NOT on the default read path:
 * the parked row exists to own media and serve the stationary registry, while
 * the events feed and the per-camera timeline exclude it by default
 * (`excludeStationaryPromotions` — operator decision: a parked object updates
 * the stationary record, it is not a passage). Retention and forensics read
 * the store WITHOUT the exclusion, so the row keeps its D161 cascade.
 *
 * An ABSENT value means "expired normally, or written before this marker
 * existed". Never read an absence as a positive — same rule as `hasFace`.
 */
const TRACK_CLOSE_REASONS = ['stationary-promotion'] as const
export type TrackCloseReason = (typeof TRACK_CLOSE_REASONS)[number]

function parseCloseReason(value: unknown): TrackCloseReason | undefined {
  return TRACK_CLOSE_REASONS.find((reason) => reason === value)
}

/**
 * The cap `Track` shape plus this addon's own close marker.
 *
 * `closedReason` is deliberately NOT on `Track` in `@camstack/types`: that
 * package is `external` to the addon build and travels inside the published
 * `@camstack/server` closure, so a field added there is not live until a
 * framework train is installed AND is silently stripped by the cap schema
 * until it lands. The column, the write and both readers all live in this
 * addon, so the marker is live on the next `camstack deploy`. Promoting it to
 * `Track` later is additive.
 */
export interface PersistedTrack extends Track {
  readonly closedReason?: TrackCloseReason
  /**
   * WHY this track ended without a native best-shot tile (D276/B2) — composed
   * by `composePreviewMissReason` at close (`no-key-frame
   * capture=keyframe:native-missx4`, `derive-returned-null tile=standin`, …)
   * and CLEARED by the late keyFrame upgrade when a native tile lands after
   * all. Absent = the tile landed native, or the row predates the column.
   * Addon-local for the same reason as `closedReason` above: live on the next
   * `camstack deploy`; the wire copy on the cap `Track` needs a framework
   * train and is stripped until then.
   */
  readonly previewMissReason?: string
  /**
   * How many sightings the row's trajectory actually holds.
   *
   * Served by the `observations` COLUMN, so it survives `projection: 'slim'` —
   * which since the SQL projection landed genuinely does not read the ~9 kB
   * `positions` blob, rather than reading it and declining to return it. Rows
   * written before that column carry NULL: a full read still counts the blob it
   * fetched anyway, a slim read reports this field ABSENT (never `0` — it read
   * neither source, and a number would be a confident lie).
   *
   * One entry is appended per frame the tracker emitted this track
   * ({@link TrackStore.upsert}), so this is the durable count of times the
   * pipeline recorded the subject. It exists because a reader that wants to
   * re-apply the tracker's own promotion threshold (`minHits`) to a CLOSED row
   * would otherwise have to pull the ~9 kB position blob to count two entries.
   *
   * Above `maxPositionHistory` the trail is downsampled, so the count is a
   * lower bound on a long track and exact on a short one — which is the only
   * end that any `>= minHits` test can turn on.
   */
  readonly observations?: number
  /**
   * Pinned by a PROMOTED tracking-tape window (D681). Addon-local for the same
   * reason as `closedReason` above: live on the next `camstack deploy`; the
   * wire copy on the cap `Track` needs a framework train and is stripped
   * until then. Undefined = never pinned.
   */
  readonly benchPinned?: boolean
  /**
   * The track's own "did it ever move?" verdict (D683 round 4, Task 14 fix
   * round 2 — review R2), judged on EVERY box as it arrived
   * (`MovedProbe`, see `promotion-plan.ts`) and written at persist. The
   * stored trail cannot answer it after a long dwell: its older half is
   * halved every time it fills, and a walk-in ends up as one box.
   *
   * A promotion reads it to decide a persisted SOURCE's fate: kept if it
   * moved, disposed only if it did not. Absent = the row predates the column
   * — and an absence is never read as "never moved" (the source is left
   * alone). Addon-local for the same reason as `closedReason` above.
   */
  readonly moved?: boolean
}

/**
 * Which detector pass measured a stored position (D399).
 *
 * `frame` — the full-frame pass, on the ≤3200-px analysis raster.
 * `recovery` — `small-subject-recovery.ts`, a second run of the same detector
 *   on a 640–800 px NATIVE square around a motion region the full-frame boxes
 *   did not account for (D377/D378).
 *
 * Both write into one `positions` array. Until this field existed the only way
 * to tell them apart was the decimal expansion of the bbox — full-frame boxes
 * are exact multiples of 1.2 (an integer box on a 3200-px raster, ×1.2 to 4K),
 * recovery boxes are full-precision floats — and that arithmetic is how the
 * 2026-09-08 operator-debug audit identified five affected tracks by hand. It
 * is also the whole of `b8ff2579`'s note ("la traccia non coincide con la box"):
 * one recovery box, 190 px below the eleven around it, was the position of
 * record for both the `firstFrame` capture and the appearance event's bbox.
 */
export type TrackPositionSource = 'frame' | 'recovery'

export interface TrackPosition {
  readonly x: number
  readonly y: number
  readonly timestamp: number
  readonly bbox: { x: number; y: number; w: number; h: number }
  /** Which detector pass measured this box. Absent on rows written before D399. */
  readonly source?: TrackPositionSource
  /** The detection score of the box, so a position can be weighed and not only
   *  plotted. Absent on rows written before D399. */
  readonly score?: number
}

/**
 * `positions` in TIME order (D399).
 *
 * The array is APPENDED in arrival order and the two detector passes interleave,
 * so it is not the same thing: seven of the fourteen tracks the 2026-09-08 audit
 * read had at least one position whose timestamp preceded its predecessor's, and
 * a consumer that draws the array as a polyline draws a path crossing back on
 * itself. Everything that reasons about a first, a last, or a velocity was
 * reading them as stored.
 *
 * Immutable — returns a new array; `toSorted` is stable, so positions sharing a
 * timestamp keep their arrival order relative to each other. Applied at the READ
 * boundaries only: the write path keeps arrival order on purpose, because that
 * is a fact about delivery and `totalDistance` has always been accumulated on it.
 */
export function positionsInTimeOrder(
  positions: readonly TrackPosition[],
): readonly TrackPosition[] {
  return positions.toSorted((a, b) => a.timestamp - b.timestamp)
}

export interface TrackSnapshot {
  readonly timestamp: number
  readonly position: TrackPosition
  readonly mediaId: number
}

/** Mutable per-label aggregate behind `Track.audioLabels`. One "episode" =
 *  one persisted audio event (confident-classification path), NOT one 32 ms
 *  inference chunk — see `addAudioLabelEpisode`. Exported for `track-merge.ts`,
 *  which folds two tracks' maps into one on an L2 fusion (D683). */
export interface MutableAudioLabelAgg {
  peakScore: number
  count: number
  firstAt: number
  lastAt: number
}

export interface MutableTrackState {
  trackId: string
  deviceId: number
  className: string
  /** Tier 1 (sub-class) + tier 2 (instance), each with score + attribution.
   *  See `pipeline/label-tier.ts` — never written except through the rule. */
  label?: string
  labelScore?: number
  labelMeta?: LabelAttribution
  subLabel?: string
  subLabelScore?: number
  subLabelMeta?: LabelAttribution
  firstSeen: number
  lastSeen: number
  positions: TrackPosition[]
  snapshots: TrackSnapshot[]
  zonesVisited: string[]
  /** Deduplicated detector classes observed over the track's life (seeded
   *  with the first sighting's className, appended on reclassification). */
  classes: string[]
  totalDistance: number
  state: TrackState
  active: boolean
  lastSnapshotAt: number
  /** Bbox of the last captured periodic snapshot (or the seed/first-frame bbox
   *  set by `seedSnapshotClock`). Reference for the movement gate that skips
   *  near-identical snapshots. Undefined until the clock is seeded. */
  lastSnapshotBbox?: { x: number; y: number; w: number; h: number }
  /** The gate reference the in-flight snapshot capture displaced, so a capture
   *  that never lands can give its interval back. Undefined when no capture is
   *  pending. See `pipeline/snapshot-retry.ts`. */
  snapshotPending?: SnapshotPendingMark
  /** Consecutive snapshot captures that did not land. Reset by any landing —
   *  the bound is on a RUN of failures, never on the track's lifetime. */
  snapshotRollbacks?: number
  importance?: number
  bestEventId?: string
  importanceReason?: string
  /** Per-label audio-classification aggregate (label → episode agg).
   *  Undefined until the first confident audio episode lands. */
  audioLabels?: Map<string, MutableAudioLabelAgg>
  /** Where the operator has taken this track in the retrain lifecycle (D81).
   *  Undefined only while LIVE and never touched — a persisted row always reads
   *  a value (the column is NOT NULL DEFAULT 'none'). `staging` is the state
   *  that pins the track against retention. */
  retrainStatus?: RetrainStatus
  /** Operator flag: diagnostic attention. Undefined = never touched. */
  debug?: boolean
  /** What the operator wants checked on this track, in their own words. Lives
   *  and dies with `debug` — see `applyTrackFlags`. Undefined = no note. */
  debugNote?: string
  /** Operator flag: favourited. Pins against pruning. Undefined = never touched. */
  favourited?: boolean
  /** Pinned by a PROMOTED tracking-tape window (D681). Pins against pruning
   *  while the window is labelled; released by `debug.tape.release`/`delete`.
   *  Undefined = never pinned. */
  benchPinned?: boolean
  /** A face detail landed on this track. Set-once by `markFaceDetected`,
   *  carried into the expiry-time persist. Undefined = no face seen (yet). */
  hasFace?: boolean
  /** A face row LANDED in the gallery for this track (crop + embedding).
   *  Set-once by `markEmbeddedFace`, carried into the expiry-time persist.
   *  Undefined = no gallery row (yet) — never "no face". */
  hasEmbeddedFace?: boolean
  hasRider?: boolean
  /** Why this track was closed EARLY — see {@link TrackCloseReason}. Set by
   *  `closeActive` immediately before the row is written; undefined on every
   *  track that expires on its TTL. */
  closedReason?: TrackCloseReason
  /** The model + frame size of the frame this track was BORN on (D646).
   *  Set once, by the first `upsert`; a later frame never rewrites it. */
  provenance?: TrackProvenance
  /** WHERE the frame that opened this track was inferred (node, inference
   *  device, root model). Set once, by the first `upsert`. */
  openedPlacement?: TrackPlacement
  /** WHERE the last MATCHED sighting was inferred — rewritten by every real
   *  sighting, never by a coasted frame. Differs from `openedPlacement` when
   *  the camera's session hopped node or device mid-track (D916). */
  closedPlacement?: TrackPlacement
  /** "Has this track moved?", judged on EVERY observed box as it arrives
   *  (D683 round 4, fix round 1 M1) — the stored trail is downsampled and
   *  can no longer answer after a long dwell. Read at promotion. */
  movedProbe: MovedProbe
  /** A registry promotion KEPT this track (it moved): it closes normally at
   *  its TTL — never discarded or stamped as a parked re-sighting (C1). */
  keptAtPromotion?: true
}

export interface TrackStoreConfig {
  /** Milliseconds without a sighting before a track is marked inactive. */
  readonly ttlMs: number
  /** Maximum positions retained per track (FIFO trim beyond this). */
  readonly maxPositionHistory: number
  /** How many CLOSED track ids stay remembered (see {@link TrackStore.rowClosedAt}). */
  readonly closedRowMemory: number
}

const DEFAULT_CONFIG: TrackStoreConfig = {
  ttlMs: 30_000,
  maxPositionHistory: 300,
  closedRowMemory: 4096,
}

/** `queryRecent` page-size defaults (mirrors the cap input's bounds). */
const RECENT_DEFAULT_LIMIT = 200
const RECENT_MAX_LIMIT = 1000

/**
 * Total track rows ONE `queryRecent` may make the settings engine materialise,
 * across every device in the request.
 *
 * `RECENT_MAX_LIMIT` bounds the PAGE. It does not bound the READ: the k-way
 * merge needs `limit + 1` rows from each device before it can know which ones
 * survive, so the read is `deviceCount x (limit + 1)` and nothing bounded
 * `deviceCount`.
 *
 * What that cost, measured. On 2026-08-07 a viewer app came back to the
 * foreground after 244 s and asked for a 12-hour window over **16 cameras with
 * limit 960 — twice, 33 ms apart**. That is 2 x 15 376 = 30 752 track rows
 * requested at once, on a table whose `positions` JSON averages **10 KB per
 * row** (47 MB of the 54 MB table), every one of them parsed into JS objects in
 * hub-main. The heap went 644 MB → 4 090 MB in 17 silent seconds and hit the
 * 4 288 MB limit; the final Mark-Compact reclaimed 4 MB of 4 090, so the memory
 * was LIVE, not uncollected garbage. The same stack (`Statement::JS_all`) had
 * already killed the hub on 01/08 twice and 02/08 twice.
 *
 * 2 000 rows is ~23 MB of `positions` text before parsing — an order of
 * magnitude under the routine p95 heap (2 108 MB) rather than a multiple of it.
 *
 * **Nothing is lost when this bites.** The page shrinks and `nextCursor` is
 * returned, which is the paging contract every caller already follows; the
 * alternative (serving one enormous page) is the one that loses the whole
 * process. It is not a substitute for reading fewer COLUMNS — see the note on
 * `queryRecent` about pushing the slim projection into the SELECT.
 */
export const RECENT_FANOUT_ROW_BUDGET = 2_000

/** Wide inclusive bound for the envelope-overlap `BETWEEN` prefilter.
 *  Envelope values are normalized ~0..1 but a bbox can spill slightly past
 *  the frame edge; ±1e6 keeps every real value inside the range while the
 *  opposing bound does the actual overlap cut. */
const ENV_RANGE_SLACK = 1e6

/**
 * Precise zone test over a persisted track row: NULL envelope or NULL frame
 * dims → PASS (the row cannot be tested); otherwise run the per-position
 * geometry test against the stored pixel positions + dims.
 */
interface ZoneTestPosition {
  readonly x: number
  readonly y: number
  readonly bbox: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
}

export function rowMatchesZone(data: Record<string, unknown>, zone: TrackZoneFilter): boolean {
  const fw = data['frameWidth']
  const fh = data['frameHeight']
  if (typeof fw !== 'number' || typeof fh !== 'number') return true
  // Through `decodePositions`, NOT `Array.isArray` (D471). Since positions are
  // stored compressed, this column arrives as a STRING — and the old guard
  // read that as "cannot be tested" and PASSED every row, which would have
  // turned the server-side zone filter off while leaving it looking like it
  // worked. The decoder answers an array for every era of stored value.
  const positions = decodePositions(data['positions'])
  if (positions.length === 0) return true
  const positionRows: ZoneTestPosition[] = []
  for (const p of positions) {
    if (p === null || typeof p !== 'object') continue
    if (!('x' in p) || typeof p.x !== 'number' || !('y' in p) || typeof p.y !== 'number') continue
    if (!('bbox' in p) || p.bbox === null || typeof p.bbox !== 'object') continue
    const b = p.bbox
    if (!('x' in b) || typeof b.x !== 'number' || !('y' in b) || typeof b.y !== 'number') continue
    if (!('w' in b) || typeof b.w !== 'number' || !('h' in b) || typeof b.h !== 'number') continue
    positionRows.push({ x: p.x, y: p.y, bbox: { x: b.x, y: b.y, w: b.w, h: b.h } })
  }
  return positionsIntersectZone(positionRows, fw, fh, zone)
}

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row when a tracked object EXPIRES — persistCompleted upserts at TTL,
 *     so an active track lives in RAM only and a restart loses nothing but the
 *     tracks still in flight. Plus persistSyntheticTrack for the marker tracks.
 *     The row is then UPDATED in place for the tiered label, importance and
 *     bestEventId, the retrain status and the operator flags."
 *   retention="THE cascading age root — the track sweep selects on lastSeen per
 *     device (trackRetentionDays, or the follow-recordings horizon; default 7 days,
 *     0 = keep forever) and deleting a row pulls its object events, media, face and
 *     plate rows and its CLIP vector away with it. Rows with retrainStatus
 *     'staging', favourited, or benchPinned (a promoted tracking-tape window,
 *     D681) are PINNED out of the sweep until the operator is done (D81)."
 */
export const TRACKS_COLLECTION = 'pipeline-analytics:tracks'

export const TRACKS_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'className', type: 'TEXT' as const, notNull: true },
  // The TIERED label model (roadmap 4g). Two independent slots — tier 1
  // (`label`, the sub-class) and tier 2 (`subLabel`, the instance) — each with
  // the score and the attribution of the step that decided it. Separate columns
  // are the guarantee: a tier-1 write physically cannot overwrite a species.
  // NULLABLE by design; `subLabel ?? label` is the display value.
  //
  // These columns reach SQLite only when `declareCollection` re-runs `ensureTable`
  // with a CHANGED fingerprint — see the 2026-08-08 `ensureTable` fix. Deploying
  // this addon against a hub-main that predates that fix leaves them absent, and
  // an absent column does not error: `compileFilter` SKIPS a predicate it cannot
  // express and the query returns everything.
  { name: 'label', type: 'TEXT' as const },
  { name: 'labelScore', type: 'REAL' as const },
  { name: 'labelMeta', type: 'JSON' as const },
  { name: 'subLabel', type: 'TEXT' as const },
  { name: 'subLabelScore', type: 'REAL' as const },
  { name: 'subLabelMeta', type: 'JSON' as const },
  // Track provenance: 'pipeline' (default/absent) vs 'sensor' (synthetic
  // projection of a linked sensor/control state change). NULL ⇒ pipeline.
  { name: 'source', type: 'TEXT' as const },
  // Synthetic (source:'sensor') tracks: NAME of the device that produced the
  // event, persisted so clients can label the marker. NULL for pipeline tracks.
  { name: 'producingDeviceName', type: 'TEXT' as const },
  { name: 'firstSeen', type: 'INTEGER' as const, notNull: true },
  { name: 'lastSeen', type: 'INTEGER' as const, notNull: true },
  { name: 'positions', type: 'JSON' as const },
  { name: 'snapshots', type: 'JSON' as const },
  { name: 'zonesVisited', type: 'JSON' as const },
  { name: 'classes', type: 'JSON' as const },
  { name: 'totalDistance', type: 'REAL' as const },
  { name: 'state', type: 'TEXT' as const },
  { name: 'importance', type: 'REAL' as const },
  { name: 'bestEventId', type: 'TEXT' as const },
  { name: 'importanceReason', type: 'TEXT' as const },
  { name: 'audioLabels', type: 'JSON' as const },
  // Per-track OPERATOR state (never written by the pipeline).
  //
  // `retrainStatus` IS the retention pin AND the retrain lifecycle (D81, enum
  // form — operator decision 2026-08-07): `none → staging → trained`. The age
  // sweep selects its candidates with `whereIn: ['none','trained']`, using the
  // only predicates the filter language offers — positive equality and IN;
  // there is no negation and no IS NULL. Only `staging` is held; `trained` is
  // EVICTABLE again, because the retrain page COPIES the frames it selects into
  // the retrain dataset, so nothing downstream still depends on this track's
  // media.
  //
  // `TEXT NOT NULL DEFAULT 'none'` is the load-bearing part: SQLite
  // materialises the default for existing rows on `ALTER TABLE … ADD COLUMN`,
  // so every row written before the column existed lands `'none'` — matched by
  // the sweep, evictable. A NULLABLE column would be unselectable by any
  // predicate this language can express and would make the whole history
  // silently immortal.
  //
  // `debug` is attention, not durability — it does not pin (D81) and keeps
  // the nullable collapse-to-false read.
  { name: 'retrainStatus', type: 'TEXT' as const, notNull: true, defaultValue: 'none' },
  { name: 'debug', type: 'BOOLEAN' as const },
  // The operator's sentence about what to check on this track. NULLABLE with no
  // default, exactly like `debug` above and for the same reason: a row written
  // before the column exists must read back as "no note", not as an empty one
  // the operator supposedly typed. Nothing ever FILTERS on it — it is carried,
  // not queried — so the absence of a default costs no predicate.
  //
  // Bounded at the wire by `MAX_TRACK_DEBUG_NOTE_LEN`; SQLite TEXT has no
  // length of its own, and the reason the bound is up there and not here is
  // that three surfaces write this column through one cap method.
  { name: 'debugNote', type: 'TEXT' as const },
  // BOOLEAN pin against retention — nullable like `debug` so a never-touched
  // row stays ABSENT (the prune query uses NULL-safe `whereNot: { favourited:
  // true }`, which keeps NULL and false). Not a retrain lifecycle.
  { name: 'favourited', type: 'BOOLEAN' as const },
  // BOOLEAN pin against retention, set only by a PROMOTED tracking-tape window
  // (D681) — nullable like `favourited` so an unpinned row stays ABSENT and the
  // NULL-safe `whereNot` keeps it evictable. `debug` still pins nothing (D81).
  { name: 'benchPinned', type: 'BOOLEAN' as const },
  // A face DETECTOR found a face on this track. Written by the pipeline (never
  // by an operator), set-once, never cleared — see `TrackStore.markFaceDetected`.
  //
  // NULLABLE with no default, exactly like `debug` and for the same reason: the
  // only query anyone wants is "the tracks that HAVE a face", and positive
  // equality on `true` expresses it while a NOT NULL DEFAULT would make every
  // pre-column row claim `false`. Absent means "this row predates the column",
  // NOT "no face" — nothing may render an absence as a negative.
  //
  // Same caveat as the tiered-label columns above: this column reaches SQLite
  // only when `declareCollection` re-runs `ensureTable` with a CHANGED
  // fingerprint (the 2026-08-08 fix). Against an older hub-main the column is
  // simply absent, the write is dropped by the backend and `compileFilter`
  // SKIPS any predicate on it — the field then never appears, which is exactly
  // the "absent ⇒ render nothing" case the read rule already covers.
  { name: 'hasFace', type: 'BOOLEAN' as const },
  // This track has a face row IN THE GALLERY — a crop AND an embedding, i.e. a
  // face an operator could ASSIGN. The STRICT twin of `hasFace` above: same
  // shape, same NULLABLE-no-default rule, same "absent means the row predates
  // the column", but written at the OTHER end of the face chain — only after
  // `FaceRecognizer.onTrackEnd` persisted the gallery row, past every gate that
  // can refuse the face. See `TrackStore.markEmbeddedFace`.
  //
  // Two columns rather than one tri-state because the useful query is the
  // DIFFERENCE: `hasFace` true with this one absent is "a face was seen and
  // nothing assignable came of it" — the enrichment-loss set. Positive equality
  // on each expresses both halves; a NOT NULL default would make every
  // pre-column row claim it had no gallery face.
  { name: 'hasEmbeddedFace', type: 'BOOLEAN' as const },
  // This vehicle CONTAINS a folded rider (D34). Same shape and same rules as
  // `hasFace` above — pipeline-written, set-once, never cleared, NULLABLE with
  // no default so a pre-column row reads ABSENT rather than claiming "no
  // rider". See `TrackStore.markRiderFolded` and `Track.hasRider`.
  { name: 'hasRider', type: 'BOOLEAN' as const },
  // Normalized 0..1 trajectory envelope (min/max over every position bbox,
  // divided by the track's frame dims), computed at persist time — the SQL
  // prefilter for the zone-filtered track query. NULL when the frame dims
  // were unknown for the track (a NULL envelope always MATCHES a zone query).
  { name: 'envMinX', type: 'REAL' as const },
  { name: 'envMinY', type: 'REAL' as const },
  { name: 'envMaxX', type: 'REAL' as const },
  { name: 'envMaxY', type: 'REAL' as const },
  // Detection-frame dims (pixels) the track's positions live in — lets the
  // precise per-position zone test normalize the pixel bboxes at query time.
  // NULL alongside the envelope when dims were unknown at persist time.
  { name: 'frameWidth', type: 'INTEGER' as const },
  { name: 'frameHeight', type: 'INTEGER' as const },
  // The ROOT model that produced the track (D646) — the `rootModelId` of the
  // frame it was born on. NULLABLE with no default for the same reason as
  // `hasFace`: a row from before the column, and an onboard-detector track,
  // name no model, and nothing may render that absence as a model.
  { name: 'modelId', type: 'TEXT' as const },
  // Why the row was written EARLY — see {@link TrackCloseReason}. Written once,
  // by `closeActive`, immediately before the row lands; every other persist
  // leaves it NULL.
  //
  // NULLABLE with no default, for the fourth time and the same reason as
  // `hasFace` / `hasEmbeddedFace` / `hasRider`: the only query anyone wants is "the tracks that
  // WERE closed for reason R", positive equality expresses it, and a NOT NULL
  // default would make every pre-column row claim a reason it never had.
  // Absent means "expired normally OR predates the column" — never a positive.
  { name: 'closedReason', type: 'TEXT' as const },
  /** See {@link PersistedTrack.moved}. NULLABLE, no default: a pre-column row
   *  reads ABSENT, never "did not move". */
  { name: 'moved', type: 'BOOLEAN' as const },
  /** See {@link PersistedTrack.previewMissReason}. NULL = native tile landed
   *  (or pre-column row) — never rendered as a negative. */
  { name: 'previewMissReason', type: 'TEXT' as const },
  /**
   * `positions.length` at persist time — the SIGHTING COUNT as a real column.
   *
   * It exists so `projection: 'slim'` can answer "how many sightings" without
   * reading the trajectory. It used to be derived on read, from the blob, and
   * that was only tenable while slim meant "read the whole row, then drop it in
   * JS": the reader saved nothing, it just did not SEE the bytes it had already
   * paid for. Now the slim SELECT omits `positions`, so the count has to be
   * stored or it cannot exist.
   *
   * NULLABLE with no default, and this time not for the usual
   * absent-is-never-a-positive reason: rows written before the column simply
   * have no count, and NULL says exactly that. A FULL read still derives it
   * from the blob for those rows, so only a slim read of a pre-column row
   * reports the field absent — a day of new rows, at these retention windows.
   */
  { name: 'observations', type: 'INTEGER' as const },
  // WHERE the track was detected (node, inference device, root model): the
  // frame that OPENED it and the last sighting that CLOSED it — see
  // `TrackPlacementSchema`. JSON, NULLABLE, no default: a pre-column row names
  // no placement, and nothing may render that absence as a node. No index —
  // nothing queries by placement; the detail read fetches the row by id.
  { name: 'openedPlacement', type: 'JSON' as const },
  { name: 'closedPlacement', type: 'JSON' as const },
] as const

/** Arguments to {@link TrackStore.countStaging}. */
export interface StagingCountQuery {
  readonly deviceId: number
  /** Count only tracks last seen BEFORE this instant — what a sweep at this
   *  cutoff declined to delete. Omitted ⇒ every staging track on the device. */
  readonly olderThanMs?: number
}

/**
 * The columns `rowToTrack` reads, per projection — the SELECT list the store
 * sends, and nothing else.
 *
 * ONE list, derived from the two heavy column names, because a projection is a
 * promise between the SELECT and the mapper: the day they disagree, nothing
 * fails. SQLite returns the row without the column, the mapper reads
 * `data['positions']`, gets `undefined`, and quietly reports a track with no
 * trajectory. So the mapper does not read what this list does not fetch, and
 * this list is the only place the drop is decided.
 *
 * `undefined` means "the whole row" — `projection: 'full'` is the default and
 * stays byte-identical to what shipped before.
 */
const TRACK_HEAVY_COLUMNS: readonly string[] = ['positions', 'snapshots']

/** Every declared column name. The pk is included; the engine returns it either
 *  way and naming it is how a caller says "ids only". */
const ALL_TRACK_COLUMN_NAMES: readonly string[] = TRACKS_COLUMNS.map((c) => c.name)

/** `full` minus the two JSON blobs that dominate the row. On the live table
 *  these are 131.5 MB of `positions` and 7.8 MB of `snapshots` across 17 870
 *  rows — a 501-row page costs 4.6 MB whole and 0.11 MB projected. */
const SLIM_TRACK_COLUMN_NAMES: readonly string[] = ALL_TRACK_COLUMN_NAMES.filter(
  (n) => !TRACK_HEAVY_COLUMNS.includes(n),
)

/**
 * The SELECT list for a projection, or `undefined` for the whole row.
 *
 * `needsPositions` is the zone-filtered read: `rowMatchesZone` runs the precise
 * per-position test on the STORED trajectory before the projection drops it, so
 * that branch has to fetch the blob whatever the caller asked for. It still
 * saves `snapshots`, and the returned track is still slim — see `rowToTrack`,
 * which reports `observations` as ABSENT in slim mode regardless, so the shape a
 * caller sees never depends on which internal branch served it.
 */
function trackColumnsFor(
  projection: TrackProjection | undefined,
  needsPositions = false,
): readonly string[] | undefined {
  if (projection !== 'slim') return undefined
  return needsPositions ? [...SLIM_TRACK_COLUMN_NAMES, 'positions'] : SLIM_TRACK_COLUMN_NAMES
}

/**
 * The SELECT list for an IDS-ONLY recent page: the primary key (free, always
 * returned) plus `lastSeen`.
 *
 * `lastSeen` is not an optimisation to shave off later — {@link
 * TrackStore.recentPage} orders on it, windows on it and breaks
 * same-millisecond ties with it. Reading ids without it would produce a page in
 * whatever order the engine felt like and a cursor that cannot resume.
 */
const RECENT_IDS_COLUMNS: readonly string[] = ['lastSeen']

/** Spreadable `columns` for a store query — omitted entirely for `full`. */
function projectionArg(
  projection: TrackProjection | undefined,
  needsPositions = false,
): { columns?: readonly string[] } {
  const columns = trackColumnsFor(projection, needsPositions)
  return columns === undefined ? {} : { columns }
}

const TRACKS_INDEXES = [
  { name: 'idx_tracks_device_lastSeen', columns: ['deviceId', 'lastSeen'] as const },
  { name: 'idx_tracks_device_firstSeen', columns: ['deviceId', 'firstSeen'] as const },
  // (Fix round, L4, D447.) `countBenchPinned` is a scheduled aggregate
  // (called on every retention pass, `index.ts`'s hourly sweep) reading
  // `deviceId`, `benchPinned` and — when `olderThanMs` is given —
  // `lastSeen`, none of which `idx_tracks_device_lastSeen` carries alongside
  // `benchPinned`. Without this, `COUNT(*) WHERE deviceId = ? AND
  // benchPinned = ?` finds the range on the existing index and then fetches
  // the table row behind every match — the exact shape D447 measured holding
  // the settings thread for seconds. Equality columns first, then the range
  // column, so a covering plan serves both the bare count and the
  // `olderThanMs` form.
  {
    name: 'idx_tracks_device_benchPinned',
    columns: ['deviceId', 'benchPinned', 'lastSeen'] as const,
  },
] as const

export interface TrackStoreDeps {
  readonly store: SettingsStoreClient
  readonly logger: IScopedLogger
  readonly config?: Partial<TrackStoreConfig>
  /** Latest detection-frame dims per device (pixels) — used at persist time
   *  to compute the normalized trajectory envelope. Returning `undefined`
   *  leaves the envelope columns NULL for the track. */
  readonly frameDims?: (deviceId: number) => { w: number; h: number } | undefined
  /**
   * D692: called synchronously after an IN-RAM track's label changed (a live track, or one
   * whose close is still persisting — harmless for the NC, which overlays a closed member
   * or keeps the promotion for a later admission) — an accepted
   * tier write (`applyLabelCandidate`, the one choke point of the face recogniser,
   * plate OCR and both gallery assignments) or a retracted tier (`clearLabel`, D665).
   * Never for a persisted-only row: a closed track is final and its close carries
   * the label. A hook that throws is logged and never fails the write.
   */
  readonly onLabelChanged?: (changed: TrackLabelChanged) => void
}

/** The tier columns a label change reports — see {@link TrackStoreDeps.onLabelChanged}. */
export interface TrackLabelTiers {
  readonly label?: string
  readonly subLabel?: string
  readonly subLabelMeta?: LabelAttribution
}

/** A label change on an ACTIVE track, with the track's tiers AFTER the change. */
export interface TrackLabelChanged {
  readonly deviceId: number
  readonly trackId: string
  readonly change: 'accepted' | 'cleared'
  readonly tiers: TrackLabelTiers
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Validate the JSON column back into `Track.audioLabels` — a malformed row
 *  yields null rather than a lying shape (this column now carries the meaning
 *  of an audio row, D189; it must not be trusted by assertion). */
function readAudioLabels(v: unknown): Track['audioLabels'] | null {
  if (!Array.isArray(v)) return null
  const out: NonNullable<Track['audioLabels']>[number][] = []
  for (const e of v) {
    if (
      isRecord(e) &&
      typeof e['label'] === 'string' &&
      typeof e['peakScore'] === 'number' &&
      typeof e['count'] === 'number' &&
      typeof e['firstAt'] === 'number' &&
      typeof e['lastAt'] === 'number'
    ) {
      out.push({
        label: e['label'],
        peakScore: e['peakScore'],
        count: e['count'],
        firstAt: e['firstAt'],
        lastAt: e['lastAt'],
      })
    }
  }
  return out.length > 0 ? out : null
}

/** Serialize the per-label aggregate map into the `Track.audioLabels`
 *  array shape, most-frequent label first. */
function audioLabelsToArray(
  agg: ReadonlyMap<string, MutableAudioLabelAgg>,
): NonNullable<Track['audioLabels']> {
  return [...agg.entries()]
    .map(([label, a]) => ({
      label,
      peakScore: a.peakScore,
      count: a.count,
      firstAt: a.firstAt,
      lastAt: a.lastAt,
    }))
    .sort((a, b) => b.count - a.count)
}

function cloneTrack(t: MutableTrackState): PersistedTrack {
  return {
    trackId: t.trackId,
    deviceId: t.deviceId,
    className: t.className,
    label: t.label,
    labelScore: t.labelScore,
    labelMeta: t.labelMeta,
    subLabel: t.subLabel,
    subLabelScore: t.subLabelScore,
    subLabelMeta: t.subLabelMeta,
    firstSeen: t.firstSeen,
    lastSeen: t.lastSeen,
    // Time order, not arrival order — see `positionsInTimeOrder` (D399).
    positions: positionsInTimeOrder(t.positions).map((p) => ({ ...p, bbox: { ...p.bbox } })),
    snapshots: t.snapshots.map((s) => ({
      ...s,
      position: { ...s.position, bbox: { ...s.position.bbox } },
    })),
    zonesVisited: [...t.zonesVisited],
    classes: [...t.classes],
    totalDistance: t.totalDistance,
    state: t.state,
    active: t.active,
    ...(t.importance !== undefined ? { importance: t.importance } : {}),
    ...(t.bestEventId !== undefined ? { bestEventId: t.bestEventId } : {}),
    ...(t.importanceReason !== undefined ? { importanceReason: t.importanceReason } : {}),
    ...(t.audioLabels !== undefined && t.audioLabels.size > 0
      ? { audioLabels: audioLabelsToArray(t.audioLabels) }
      : {}),
    // `markForTrain` is DERIVED, never stored beside the status: it is exactly
    // `staging`. A `trained` track therefore reports `false`, which is what
    // stops it re-entering the export selection and the staging budget.
    ...(t.retrainStatus !== undefined
      ? { retrainStatus: t.retrainStatus, markForTrain: t.retrainStatus === 'staging' }
      : {}),
    ...(t.debug !== undefined ? { debug: t.debug } : {}),
    ...(t.debugNote !== undefined ? { debugNote: t.debugNote } : {}),
    ...(t.favourited !== undefined ? { favourited: t.favourited } : {}),
    ...(t.benchPinned !== undefined ? { benchPinned: t.benchPinned } : {}),
    // Judged on every box as it arrived — the trail below cannot (R2).
    moved: probeMoved(t.movedProbe),
    ...(t.hasFace !== undefined ? { hasFace: t.hasFace } : {}),
    ...(t.hasEmbeddedFace !== undefined ? { hasEmbeddedFace: t.hasEmbeddedFace } : {}),
    ...(t.hasRider !== undefined ? { hasRider: t.hasRider } : {}),
    ...(t.closedReason !== undefined ? { closedReason: t.closedReason } : {}),
    ...(t.provenance?.modelId !== undefined ? { modelId: t.provenance.modelId } : {}),
    ...(t.provenance !== undefined
      ? { frameWidth: t.provenance.frameWidth, frameHeight: t.provenance.frameHeight }
      : {}),
    ...(t.openedPlacement !== undefined ? { openedPlacement: { ...t.openedPlacement } } : {}),
    ...(t.closedPlacement !== undefined ? { closedPlacement: { ...t.closedPlacement } } : {}),
  }
}

/** Ids per set-based `benchPinned` statement — well under SQLite's bound
 *  parameter limit, and the same page `existingTrackIds` reads by. */
const BENCH_PIN_CHUNK = 500

/**
 * THE one trail-capping rule (D683 Task 16): repeatedly halve the OLDER half
 * (keep every other point of it) until the trail fits `max` — a single pass
 * is enough for the live per-frame append (the trail is never more than one
 * point over the cap when this runs), and the loop is what lets the SAME rule
 * cap an L2 merge's union of two already-capped trails, which can start out
 * at up to twice `max`.
 *
 * The newest point is always the last element of the array, always inside
 * the "second half" kept WHOLE by every pass, so it is never thinned —
 * `upsert`'s caller and `track-merge.ts`'s `positions` rule both rely on the
 * tail surviving intact.
 */
export function downsampleTrail(positions: readonly TrackPosition[], max: number): TrackPosition[] {
  let out: readonly TrackPosition[] = positions
  while (out.length > max) {
    const half = Math.floor(out.length / 2)
    out = out.filter((_, i) => i >= half || i % 2 === 0)
  }
  return [...out]
}

/** The ids one survivor absorbed, and its camera (for `clearDevice`). */
interface TrackMembers {
  readonly deviceId: number
  readonly ids: readonly string[]
}

/** A row as a fusion sees it (D683 Task 18) — see {@link TrackStore.rowState}. */
export type TrackRowState = 'active' | 'closing' | 'closed' | 'none'

export class TrackStore {
  private readonly active = new Map<string, MutableTrackState>()
  /**
   * trackId → the instant THIS store closed (or deleted) the track's row.
   *
   * The `active` map alone cannot answer "is this row still open?": a sighting
   * for an already-closed id re-creates a fresh active entry (`upsert`), which
   * is exactly how a person track closed 4.4 minutes earlier received a dog's
   * `thumbnail`, `keyFrame` and `lastFrame` on 2026-08-21. This is POSITIVE
   * knowledge of a close the store performed — an id it has never heard of, or
   * one evicted by the bound below, reads as WRITABLE (D49): losing a live
   * track's media is worse than tolerating a late write.
   *
   * Insertion-ordered and bounded by `closedRowMemory` (oldest evicted first).
   */
  private readonly closedRows = new Map<string, number>()
  /** trackIds currently held past TTL by `canClose` (D683 review M2) — lets
   *  `expireStale` log the FIRST hold of a row at debug without repeating it
   *  every sweep. Cleared when the hold ends (closed, forced, or released). */
  private readonly heldRows = new Set<string>()
  /**
   * D683 Task 18: survivor → every id it absorbed through {@link adopt}
   * (flattened across chained fusions). When the survivor's row closes, each
   * member is noted closed at the same instant — that is what makes the
   * closed-row guard refuse a late write under an absorbed id once its
   * survivor is gone; until then such a write is accepted and the fusion
   * service's sweep-up re-points it.
   */
  private readonly members = new Map<string, TrackMembers>()
  /** D683 review N1: samples `upsert`'s own closed-id refusal the same way
   *  the capture path already samples its media refusal (D220) — one line
   *  per track per window, with a suppressed count. */
  private readonly upsertRefusalGate = new ClosedRowMediaGate()
  private readonly config: TrackStoreConfig
  private readonly logger: IScopedLogger
  private readonly store: SettingsStoreClient
  private readonly frameDims?: (deviceId: number) => { w: number; h: number } | undefined
  private readonly onLabelChanged?: (changed: TrackLabelChanged) => void

  constructor(deps: TrackStoreDeps) {
    this.logger = deps.logger
    this.store = deps.store
    this.config = { ...DEFAULT_CONFIG, ...deps.config }
    this.frameDims = deps.frameDims
    if (deps.onLabelChanged !== undefined) this.onLabelChanged = deps.onLabelChanged
  }

  /** One-time collection declaration. Call from addon onInitialize. */
  static async declare(store: SettingsStoreClient): Promise<void> {
    await store.declareCollection.mutate({
      collection: TRACKS_COLLECTION,
      database: 'events',
      columns: [...TRACKS_COLUMNS],
      indexes: [...TRACKS_INDEXES],
    })
  }

  /**
   * When this store CLOSED the track's row (TTL expiry, early close, or the
   * cascade delete), or `undefined` when it holds no such record.
   *
   * `undefined` is not "still open" — it is "no evidence of a close", and every
   * caller must treat it as permission to write (D49). Read by the frame path's
   * best-media gate; in-memory and infallible by construction.
   */
  rowClosedAt(trackId: string): number | undefined {
    return this.closedRows.get(trackId)
  }

  /**
   * The row as a fusion must see it (D683 Task 18): `closing` is a row
   * `expireStale` has marked inactive and is persisting right now — it is
   * still in RAM, but no fusion may touch it.
   */
  rowState(trackId: string): TrackRowState {
    const t = this.active.get(trackId)
    if (t !== undefined) return t.active ? 'active' : 'closing'
    return this.closedRows.has(trackId) ? 'closed' : 'none'
  }

  /** Remember a close — the row's and every id it absorbed (D683 Task 18).
   *  Bounded, oldest-first — an evicted entry fails OPEN. */
  private noteRowClosed(trackId: string, atMs: number): void {
    const members = this.members.get(trackId)?.ids ?? []
    this.members.delete(trackId)
    for (const id of [trackId, ...members]) {
      this.closedRows.delete(id)
      this.closedRows.set(id, atMs)
    }
    while (this.closedRows.size > this.config.closedRowMemory) {
      const oldest = this.closedRows.keys().next()
      if (oldest.done === true) break
      this.closedRows.delete(oldest.value)
    }
  }

  /** Create or update the track record for a sighting in this frame. */
  upsert(params: {
    trackId: string
    deviceId: number
    className: string
    /** The tier decision the frame path already made for this sighting. */
    labelPatch?: TieredLabelPatch
    timestamp: number
    position: TrackPosition
    zones: readonly string[]
    state: TrackState
    /**
     * Did the tracker MATCH a real detection this frame?
     *
     * Absent means yes — every caller that predates this behaves exactly as
     * before. `false` is a COASTED frame: the tracker is carrying the track
     * through `maxMissedMs` on a frozen or extrapolated box, and that is not a
     * sighting. Persisting it appended a position, advanced `lastSeen` and
     * accumulated distance the subject never travelled — measured live at 41%
     * of all stored person positions, and a 3.7 s phantom tail on 94% of person
     * tracks, so a track's END TIME was routinely ~4 s after the subject left.
     * The media paths already refuse these frames (`index.ts:6915`, `:8867`,
     * `:8904`); the row did not, which is why the pixels were right and the
     * geometry was wrong.
     */
    matched?: boolean
    /**
     * What the frame this sighting came from says about a track BORN on it —
     * root model + detection-frame size (D646). Read on the FIRST sighting
     * only; a later frame never rewrites a birth fact.
     */
    provenance?: TrackProvenance
    /**
     * WHERE this frame was inferred (`trackPlacementOf`). Opens the track on
     * its first sighting; every later MATCHED sighting makes it the closing
     * placement. A coasted frame never touches either.
     */
    placement?: TrackPlacement
  }): MutableTrackState {
    if (this.closedRows.has(params.trackId)) {
      // D683 review M3: this id's row is CLOSED. `canClose` makes a late
      // write unreachable in every measured scene, but not STRUCTURALLY —
      // `frameNow` extrapolates wall time, so a frame queued behind pipeline
      // latency can still arrive after the gate released (review M2's own
      // edge). Defence in depth, never silent (D391): the caller gets a
      // normal-shaped row back (nothing downstream throws), but it is NEVER
      // inserted into `this.active` — so `persistCompleted` can never see
      // it, and the closed row's persisted history is never overwritten.
      //
      // Review N1: this used to be ONE unsampled WARN per refused sighting —
      // 7-23 lines/s at frame rate for as long as a phantom keeps matching.
      // Since review N2 the frame path asks `rowClosedAt` and drops the
      // tracker's chain BEFORE ever reaching here, so this branch should now
      // be rare (a caller that skips that pre-check, or the same timing edge
      // M3 itself defends against) — but it still samples, same D220 style.
      const verdict = this.upsertRefusalGate.evaluate(
        params.trackId,
        this.closedRows.get(params.trackId),
        Date.now(),
      )
      if (verdict.log) {
        this.logger.warn('upsert refused — this track id was already closed', {
          tags: { deviceId: params.deviceId },
          meta: {
            trackId: params.trackId,
            closedAgeMs: verdict.closedAgeMs,
            suppressed: verdict.suppressed,
          },
        })
      }
      return {
        trackId: params.trackId,
        deviceId: params.deviceId,
        className: params.className,
        ...params.labelPatch,
        firstSeen: params.timestamp,
        lastSeen: params.timestamp,
        positions: [params.position],
        snapshots: [],
        zonesVisited: [...params.zones],
        classes: [params.className],
        totalDistance: 0,
        state: params.state,
        active: true,
        lastSnapshotAt: 0,
        movedProbe: stepMovedProbe(EMPTY_MOVED_PROBE, params.position.bbox),
        ...(params.provenance !== undefined ? { provenance: params.provenance } : {}),
        ...(params.placement !== undefined
          ? { openedPlacement: params.placement, closedPlacement: params.placement }
          : {}),
      }
    }
    const existing = this.active.get(params.trackId)
    if (existing) {
      // What the tracker DECIDED still applies on a coasted frame — state,
      // zones and classes are conclusions about the track, not observations of
      // the subject. Only the observation itself is withheld.
      if (params.matched === false) {
        existing.state = params.state
        for (const z of params.zones) {
          if (!existing.zonesVisited.includes(z)) existing.zonesVisited.push(z)
        }
        if (!existing.classes.includes(params.className)) existing.classes.push(params.className)
        return existing
      }
      const last = existing.positions[existing.positions.length - 1]
      const dist = last
        ? Math.sqrt((params.position.x - last.x) ** 2 + (params.position.y - last.y) ** 2)
        : 0
      existing.lastSeen = params.timestamp
      if (params.placement !== undefined) existing.closedPlacement = params.placement
      existing.totalDistance += dist
      existing.state = params.state
      existing.movedProbe = stepMovedProbe(existing.movedProbe, params.position.bbox)
      existing.positions.push(params.position)
      if (existing.positions.length > this.config.maxPositionHistory) {
        existing.positions = downsampleTrail(existing.positions, this.config.maxPositionHistory)
      }
      for (const z of params.zones) {
        if (!existing.zonesVisited.includes(z)) existing.zonesVisited.push(z)
      }
      if (!existing.classes.includes(params.className)) existing.classes.push(params.className)
      return existing
    }
    const fresh: MutableTrackState = {
      trackId: params.trackId,
      deviceId: params.deviceId,
      className: params.className,
      ...params.labelPatch,
      firstSeen: params.timestamp,
      lastSeen: params.timestamp,
      positions: [params.position],
      snapshots: [],
      zonesVisited: [...params.zones],
      classes: [params.className],
      totalDistance: 0,
      state: params.state,
      active: true,
      lastSnapshotAt: 0,
      movedProbe: stepMovedProbe(EMPTY_MOVED_PROBE, params.position.bbox),
      ...(params.provenance !== undefined ? { provenance: params.provenance } : {}),
      ...(params.placement !== undefined
        ? { openedPlacement: params.placement, closedPlacement: params.placement }
        : {}),
    }
    this.active.set(params.trackId, fresh)
    return fresh
  }

  /**
   * Record one audio-classification EPISODE against every track currently
   * active on the device — "what was heard on this camera while the track
   * was alive". Called from the confident-classification audio-event insert
   * (score ≥ device `classificationMinScore`, class-change-or-heartbeat
   * coalesced), so counts stay episode-scaled rather than 30 Hz chunk-scaled.
   */
  addAudioLabelEpisode(deviceId: number, label: string, score: number, timestamp: number): void {
    for (const t of this.active.values()) {
      if (t.deviceId !== deviceId || !t.active) continue
      const agg = (t.audioLabels ??= new Map())
      const entry = agg.get(label)
      if (entry) {
        entry.peakScore = Math.max(entry.peakScore, score)
        entry.count += 1
        entry.lastAt = timestamp
      } else {
        agg.set(label, { peakScore: score, count: 1, firstAt: timestamp, lastAt: timestamp })
      }
    }
  }

  /** Attach a snapshot reference to an active track. */
  addSnapshot(trackId: string, snapshot: TrackSnapshot): void {
    const t = this.active.get(trackId)
    if (!t) return
    t.snapshots.push(snapshot)
    t.lastSnapshotAt = snapshot.timestamp
    t.lastSnapshotBbox = { ...snapshot.position.bbox }
    // The capture LANDED: nothing left to give back, and the failure run is
    // broken — a later miss starts its budget from zero.
    delete t.snapshotPending
    t.snapshotRollbacks = 0
  }

  /**
   * Synchronously advance the periodic-snapshot gate reference (clock + bbox) at
   * the MOMENT a snapshot write is DECIDED — before the async encode/dispatch
   * lands the real snapshot via {@link addSnapshot}. Without it, `lastSnapshotAt`
   * only advances when the dispatcher round-trip returns (~50-200ms of sharp
   * encode), so at 10-25fps several consecutive frames pass
   * `evaluatePeriodicSnapshot` before the clock moves → a burst of near-identical
   * snapshots. Mirrors the synchronous `lastFrameAtByTrack` advance for the
   * rolling `lastFrame`.
   *
   * The advance is REVERSIBLE. It used to be permanent — this docblock said
   * "if the write later fails the slot is simply lost" — which made `snapshot`
   * the only media kind with no retry of any shape while every sibling advanced
   * its bookkeeping from the ids that actually persisted. See
   * {@link rollbackSnapshotPending} and `pipeline/snapshot-retry.ts`.
   *
   * `addSnapshot` re-stamps the same clock/bbox when the real snapshot lands, so
   * the two stay consistent. No-op for an unknown/expired track (the active entry
   * is dropped on expiry, so there is no separate map to leak).
   */
  markSnapshotPending(
    trackId: string,
    timestamp: number,
    bbox: { x: number; y: number; w: number; h: number },
  ): void {
    const t = this.active.get(trackId)
    if (!t) return
    t.snapshotPending = {
      at: timestamp,
      previous: {
        at: t.lastSnapshotAt,
        bbox: t.lastSnapshotBbox ? { ...t.lastSnapshotBbox } : undefined,
      },
      priorRollbacks: t.snapshotRollbacks ?? 0,
    }
    t.lastSnapshotAt = timestamp
    t.lastSnapshotBbox = { ...bbox }
  }

  /**
   * The capture decided at `timestamp` did NOT land: restore the gate reference
   * it displaced so the next frame re-evaluates instead of waiting out an
   * interval that was never used. Returns whether the slot was given back.
   *
   * Refused — deliberately — when the attempt is no longer the one the gate
   * stands on (a snapshot landed, or a newer frame already marked its own
   * pending), and once the bounded run of non-landings is spent
   * ({@link SNAPSHOT_MAX_ROLLBACKS}): a camera whose frames are permanently
   * unresolvable must not re-decide a snapshot on every frame forever.
   */
  rollbackSnapshotPending(trackId: string, timestamp: number): boolean {
    const t = this.active.get(trackId)
    if (!t) return false
    const mark = t.snapshotPending
    if (mark?.at !== timestamp) return false
    if (!canRollbackSnapshot(mark, t.lastSnapshotAt)) {
      // Budget spent: concede the slot and KEEP the count. Zeroing it here would
      // hand the same track three fresh per-frame retries after every conceded
      // slot, for ever — a 4x capture rate on exactly the camera that is already
      // failing, which is what the bound exists to prevent. Only a LANDED
      // snapshot (`addSnapshot`) breaks the run.
      delete t.snapshotPending
      return false
    }
    t.lastSnapshotAt = mark.previous.at
    if (mark.previous.bbox) t.lastSnapshotBbox = { ...mark.previous.bbox }
    else delete t.lastSnapshotBbox
    t.snapshotRollbacks = mark.priorRollbacks + 1
    delete t.snapshotPending
    return true
  }

  lastSnapshotAt(trackId: string): number {
    return this.active.get(trackId)?.lastSnapshotAt ?? 0
  }

  /** Bbox reference of the last captured snapshot (or the seed bbox), for the
   *  periodic-snapshot movement gate. Undefined until the clock is seeded. */
  lastSnapshotBbox(trackId: string): { x: number; y: number; w: number; h: number } | undefined {
    const b = this.active.get(trackId)?.lastSnapshotBbox
    return b ? { ...b } : undefined
  }

  /**
   * Seed the snapshot cadence clock (once, at track start) WITHOUT appending a
   * snapshot, so the first periodic snapshot fires ~snapshotIntervalMs after the
   * track begins rather than immediately — the `firstFrame` already covers the
   * track's start. No-op if a snapshot was already taken (clock already set).
   */
  seedSnapshotClock(
    trackId: string,
    timestamp: number,
    bbox?: { x: number; y: number; w: number; h: number },
  ): void {
    const t = this.active.get(trackId)
    if (t && t.lastSnapshotAt === 0) {
      t.lastSnapshotAt = timestamp
      // Seed the movement-gate reference with the first-frame bbox so the first
      // periodic snapshot is judged against where the track actually started.
      if (bbox) t.lastSnapshotBbox = { ...bbox }
    }
  }

  getActive(deviceId: number): readonly Track[] {
    const out: Track[] = []
    for (const t of this.active.values()) {
      if (t.deviceId === deviceId && t.active) out.push(cloneTrack(t))
    }
    return out
  }

  getActiveByTrack(trackId: string): Track | null {
    const t = this.active.get(trackId)
    return t && t.active ? cloneTrack(t) : null
  }

  /**
   * Cheap read of an active track's promotion-relevant fields WITHOUT the deep
   * clone `getActiveByTrack` does — the returned `positions` is the live
   * internal array (read-only; callers must not mutate). Feeds the per-frame
   * stationary-promotion check AND the lifecycle update gate, both called at
   * inference fps. Null if unknown/expired.
   */
  peekActive(trackId: string): {
    readonly firstSeen: number
    readonly positions: readonly TrackPosition[]
    readonly label?: string
    /** `zonesVisited.length` — cumulative, so growth means a NEW zone. */
    readonly zonesVisitedCount: number
  } | null {
    const t = this.active.get(trackId)
    if (!t || !t.active) return null
    return {
      firstSeen: t.firstSeen,
      positions: t.positions,
      zonesVisitedCount: t.zonesVisited.length,
      // The stationary promoter renders this as a caption — it wants the finest
      // thing known, not one tier of it. The lifecycle update gate reads it
      // too: the face recognizer writes an identity HERE, never into a frame
      // patch, and the gate must see it while the subject is still on camera.
      ...(displayLabel(t) !== undefined ? { label: displayLabel(t) } : {}),
    }
  }

  /**
   * What a registry promotion does to this ACTIVE track (D683 round 4): kept
   * if it ever moved, disposed if it never did. Judged on every box it was
   * seen at, not on the downsampled trail. Null if unknown/expired.
   */
  promotionPlanOf(trackId: string): PromotionPlan | null {
    const t = this.active.get(trackId)
    if (!t || !t.active) return null
    return planFromMoved(probeMoved(t.movedProbe))
  }

  /**
   * A promotion KEPT this active track (it moved, D683 round 4): it closes
   * normally at its TTL. Its last box is the box the entry was born from, so
   * without this mark `expireStale` would take it for a re-sighting of that
   * entry and discard it (review C1). Returns whether an active track was
   * marked.
   */
  markKeptAtPromotion(trackId: string): boolean {
    const t = this.active.get(trackId)
    if (!t || !t.active) return false
    t.keptAtPromotion = true
    return true
  }

  /**
   * D683: fold the ACTIVE absorbed row into the ACTIVE survivor, through the
   * one merge table (`track-merge.ts`) — the table IS the behaviour (review
   * M7), so a field the table forgets is a compile error, not a silent drop.
   *
   * A fusion never touches a closed track: if either row is not an ACTIVE
   * entry, nothing changes and `false` says so. The fusion service (Task 18)
   * checks this before it re-points any leaf store — a late commit that would
   * otherwise reopen an id this store already persisted and forgot (review
   * H4, the 38 s case) simply does not run.
   */
  adopt(survivorId: string, absorbedId: string): boolean {
    const survivor = this.active.get(survivorId)
    const absorbed = this.active.get(absorbedId)
    if (!survivor?.active || !absorbed?.active) return false
    this.active.set(
      survivorId,
      mergeActiveTracks(survivor, absorbed, { maxPositionHistory: this.config.maxPositionHistory }),
    )
    this.active.delete(absorbedId)
    // D683 review N8: the absorbed id's own held-row memory (if it was ever
    // TTL-held) is now meaningless — it no longer has a row of its own to
    // close, held or otherwise, and the set would hold its string forever.
    this.heldRows.delete(absorbedId)
    // D683 Task 18: the absorbed id (and whatever IT had absorbed) closes to
    // late writers when the survivor's row closes.
    this.noteMember(survivor.deviceId, survivorId, absorbedId)
    return true
  }

  /**
   * D683 Task 18 (fix round 1 M2/L1): record that `absorbedId` — and every id
   * it had absorbed — is now part of `survivorId`. `adopt` calls it for a
   * merged row; the fusion service calls it for a piece that had NO row to
   * merge (a deferred birth), so the survivor's close still sweeps it up and
   * closes it to late writers. THE registry of fusion membership: the fusion
   * service keeps no copy (no shadow registry). Cleaned on every close path
   * (`noteRowClosed`, `dropActive`, `clearDevice`, `clearAll`); a survivor
   * that never gets a row of its own is bounded by `closedRowMemory`,
   * oldest-first, with a debug line.
   */
  noteMember(deviceId: number, survivorId: string, absorbedId: string): void {
    const ids = [
      ...(this.members.get(survivorId)?.ids ?? []),
      absorbedId,
      ...(this.members.get(absorbedId)?.ids ?? []),
    ]
    this.members.delete(absorbedId)
    this.members.delete(survivorId)
    this.members.set(survivorId, { deviceId, ids })
    while (this.members.size > this.config.closedRowMemory) {
      const oldest = this.members.entries().next()
      if (oldest.done === true) break
      this.members.delete(oldest.value[0])
      this.logger.debug('track members forgotten at the bound — a survivor that never closed', {
        tags: { deviceId: oldest.value[1].deviceId },
        meta: { survivorId: oldest.value[0], members: oldest.value[1].ids },
      })
    }
  }

  /** Every id `survivorId` absorbed (flattened), or none. */
  membersOf(survivorId: string): readonly string[] {
    return this.members.get(survivorId)?.ids ?? []
  }

  /** Expire tracks whose `lastSeen` is older than TTL. Persists each
   *  expired track to the declared collection and returns them. */
  async expireStale(
    nowMs: number,
    opts?: {
      readonly isKnownParked?: (track: ParkedProbeTrack) => boolean
      /**
       * Receives every track this sweep DISCARDED instead of persisting
       * (D547): a scenery re-fire (≤ 25 s, net displacement under the class
       * ceiling) or a re-sighting of a live parked registry entry. The caller
       * owns the cascade of what the track wrote while it lived; the store has
       * already dropped it from RAM and never writes its row.
       */
      readonly onDiscard?: (track: Track) => void
      /**
       * D683 §6.4: a row closes only when the TRACKER says its chain is not
       * live and its tail is final (`TrackerSweep.canClose`, the production
       * frame-clock gate — review C2/M2). Undefined behaves exactly as
       * before this existed: every TTL-expired row closes. Checked BEFORE
       * `t.active = false`, so a held row stays a perfectly live active
       * entry — coastable, fusible, adoptable — rather than a half-closed one.
       *
       * Narrowed to {@link SweptTrack} (review L4): the gate reads only
       * `deviceId`/`trackId`, and the live `MutableTrackState` already
       * satisfies that shape — no `cloneTrack` needed just to ask it.
       */
      readonly canClose?: (track: SweptTrack) => boolean
      /**
       * D683 review M2: WHY `canClose` held the row, for the hold/force-close
       * log below — `canClose` itself stays a bare boolean for the hot path.
       * Absent ⇒ no reason named in the log (version-skew/test callers).
       */
      readonly canCloseReason?: (track: SweptTrack) => 'live' | 'tail-not-final' | undefined
      /**
       * D683 review N5: the processor's OWN configured coast length
       * (`TrackerV2Config.maxMissedMs`), per camera and with no ceiling of
       * its own — a chain the tracker is legitimately still coasting
       * through, past the generic bound below, must not be force-closed out
       * from under it. Absent/returning 0 ⇒ the generic bound alone (version
       * -skew/test callers).
       */
      readonly maxMissedMsOf?: (track: SweptTrack) => number
      /**
       * D683 Task 18 (review 2 L7): awaited per CLOSING track right before its
       * row is persisted — the fusion service's sweep-up, so writes that
       * landed under an absorbed id after the fusion are re-pointed before the
       * survivor's row (and from then on every absorbed id) is closed. A hook
       * that throws is logged and never keeps the row from persisting.
       */
      readonly beforePersist?: (track: Track) => Promise<void>
    },
  ): Promise<readonly Track[]> {
    const expired: Track[] = []
    for (const [trackId, t] of this.active) {
      if (nowMs - t.lastSeen < this.config.ttlMs) continue
      if (opts?.canClose !== undefined && !opts.canClose(t)) {
        // D683 review M2/N5: a hold has no bound of its own — only L2's own
        // 60 s chain prune (`LINK_WINDOW_MS`) eventually frees it, and two
        // "forever" cases exist (a processor whose silence advance throws on
        // every sweep; an absorbed piece held for the whole life of its
        // chain before Task 18 adopts it). Past
        // max(ttlMs, maxMissedMs) + the chain-prune window + two sweep
        // periods of margin, a held row closes anyway — late, not silent.
        // The `maxMissedMs` term matters: a camera configured with a long
        // coast (no ceiling in the schema) can legitimately hold a chain
        // past the ttlMs-only bound, and forcing it closed there would
        // force-close — and then refuse every later emission of (M3) —
        // a row L2 was never actually done with.
        const heldRowForceCloseMs =
          Math.max(this.config.ttlMs, opts.maxMissedMsOf?.(t) ?? 0) +
          LINK_WINDOW_MS +
          2 * TTL_SWEEP_INTERVAL_MS
        const overheldMs = nowMs - t.lastSeen
        if (overheldMs < heldRowForceCloseMs) {
          if (!this.heldRows.has(trackId)) {
            this.heldRows.add(trackId)
            this.logger.debug('track close held — the tracker has not released this chain', {
              tags: { deviceId: t.deviceId },
              meta: {
                trackId,
                reason: opts.canCloseReason?.(t) ?? 'unknown',
                overheldMs,
              },
            })
          }
          continue
        }
        this.heldRows.delete(trackId)
        this.logger.warn(
          'track close forced — past its hold bound with the tracker still holding it',
          {
            tags: { deviceId: t.deviceId },
            meta: {
              trackId,
              reason: opts.canCloseReason?.(t) ?? 'unknown',
              overheldMs,
              forceCloseBoundMs: heldRowForceCloseMs,
            },
          },
        )
      } else {
        this.heldRows.delete(trackId)
      }
      t.active = false
      // Scenery re-fire (parked plate, doorframe, bush, standing-person jitter):
      // lived ≤25 s and net displacement under the class ceiling. 40 px is bbox
      // jitter on a still person (9310d1ff); vehicles stay at 8 px so a real
      // car with 15 px net (86918072) is not read as scenery. A longer track
      // that still sits on a live parked registry box is a re-sighting of an
      // entity that already exists.
      //
      // Both used to be STAMPED `stationary-promotion` and persisted, so the
      // Events feed would hide them — and every one kept its full media set:
      // 91 rows a day at 3.23 MB each on device 102 (2026-09-19). The operator
      // does not want a parked object persisted as a track at all (D547): the
      // row is not written and the caller cascades what the track wrote.
      // A track a promotion KEPT (it moved, D683 round 4) is neither: it
      // closes normally, and its last box being the entry's box is exactly
      // why it must not be asked (review C1).
      const kept = t.keptAtPromotion === true
      const knownParked = !kept && t.positions.length > 0 && opts?.isKnownParked?.(t) === true
      const shortMotionless =
        !kept &&
        t.positions.length > 0 &&
        isShortMotionlessTrack(
          t.lastSeen - t.firstSeen,
          netDisplacementPx(t.positions),
          t.className,
        )
      const stillObject = knownParked || shortMotionless
      // A censused box is an entity's re-sighting whatever its class; a short
      // motionless PERSON is nobody's entity and keeps its row (and its face).
      const discardable = knownParked || (shortMotionless && !isDiscardExemptClass(t.className))
      // Only a caller that can CASCADE may be handed a discarded track: a
      // track that is not persisted and whose media nobody deletes is the
      // orphan D161 measured (18.9 GB). Without a sink the row is persisted and
      // stamped, exactly as before — hidden from the feed, reachable by
      // retention.
      const onDiscard = opts?.onDiscard
      if (discardable && onDiscard !== undefined) {
        const record = cloneTrack(t)
        this.active.delete(trackId)
        this.noteRowClosed(trackId, nowMs)
        this.logger.debug('track discarded on expiry — a still object is an entity, not a track', {
          tags: { deviceId: t.deviceId },
          meta: {
            deviceId: t.deviceId,
            trackId,
            className: t.className,
            lifeMs: t.lastSeen - t.firstSeen,
            netDisplacementPx: Math.round(netDisplacementPx(t.positions)),
            knownParked,
          },
        })
        onDiscard(record)
        continue
      }
      if (stillObject) t.closedReason = 'stationary-promotion'
      if (opts?.beforePersist !== undefined) {
        try {
          await opts.beforePersist(cloneTrack(t))
        } catch (err) {
          this.logger.warn('track close: the pre-persist hook failed — the row closes anyway', {
            tags: { deviceId: t.deviceId },
            meta: { trackId, error: String(err) },
          })
        }
      }
      const record = cloneTrack(t)
      try {
        await this.persistCompleted(record)
      } catch (err) {
        this.logger.warn('persist completed track failed', {
          tags: { deviceId: t.deviceId },
          meta: { trackId, error: String(err) },
        })
      }
      this.active.delete(trackId)
      this.noteRowClosed(trackId, nowMs)
      expired.push(record)
    }
    return expired
  }

  /**
   * Offer a label CANDIDATE to a track (roadmap 4g). The tier decision is
   * {@link resolveTieredLabelWrite}'s — this method resolves the track's
   * current tiers, applies the rule, and writes only when the rule says write.
   * The decision is RETURNED so the caller can log a refusal with its camera.
   *
   * The read comes from the in-RAM active entry when there is one and from the
   * persisted row otherwise: an enrichment answer routinely lands after the
   * track has expired (`applyTrackEnrichmentLabel` is invoked from the detail
   * plane), and comparing against an empty state would let a late, weaker
   * answer overwrite a stronger one that is already on the row.
   *
   * Updates the in-memory active state (so the value is carried into the
   * eventual persist) AND patches the stored row. Forward-only.
   */
  async applyLabelCandidate(
    trackId: string,
    candidate: LabelCandidate,
  ): Promise<TieredLabelDecision | null> {
    const active = this.active.get(trackId)
    const state = active !== undefined ? active : await this.readTieredState(trackId)
    if (state === null) return null
    const decision = resolveTieredLabelWrite(state, candidate)
    if (decision.kind !== 'write') return decision
    if (active) {
      Object.assign(active, decision.patch)
      // RAM first, then the hook, then the durable patch: the grouped window (D692)
      // must learn the name in the same tick the track did, not after a store await.
      this.notifyLabelChanged(active, 'accepted')
    }
    try {
      await this.store.update.mutate({
        collection: TRACKS_COLLECTION,
        id: trackId,
        data: tieredLabelColumnData(decision.patch),
      })
    } catch (err) {
      this.logger.warn('applyLabelCandidate persist failed', {
        meta: { trackId, error: String(err) },
      })
    }
    return decision
  }

  /** Tell the label-change hook (D692) about an ACTIVE track's new tiers. */
  private notifyLabelChanged(track: MutableTrackState, change: TrackLabelChanged['change']): void {
    const hook = this.onLabelChanged
    if (hook === undefined) return
    const tiers: TrackLabelTiers = {
      ...(track.label !== undefined ? { label: track.label } : {}),
      ...(track.subLabel !== undefined ? { subLabel: track.subLabel } : {}),
      ...(track.subLabelMeta !== undefined ? { subLabelMeta: track.subLabelMeta } : {}),
    }
    try {
      hook({ deviceId: track.deviceId, trackId: track.trackId, change, tiers })
    } catch (err) {
      this.logger.warn('label-change hook threw — the label write stands', {
        tags: { deviceId: track.deviceId },
        meta: { trackId: track.trackId, change, error: String(err) },
      })
    }
  }

  /** The persisted row's class + tiers, for the write rule. Null when unknown —
   *  a track that is neither active nor persisted cannot be labelled. */
  private async readTieredState(trackId: string): Promise<TieredLabelState | null> {
    try {
      const records = await this.store.query.query({
        collection: TRACKS_COLLECTION,
        filter: { where: { id: trackId }, limit: 1 },
      })
      const row = records[0]
      if (row === undefined) return null
      const data = row.data
      const className = data['className']
      if (typeof className !== 'string') return null
      return { className, ...readTieredLabelColumns(data) }
    } catch (err) {
      this.logger.warn('readTieredState failed', { meta: { trackId, error: String(err) } })
      return null
    }
  }

  /**
   * Stamp a track's importance score (+ dominant reason and best-event pointer).
   * Updates the in-memory active entry (so the value is carried into an eventual
   * (re)persist) AND patches the already-persisted row. Mirrors `setLabel`.
   * Forward-only — never rewrites history beyond these fields.
   */
  async setImportance(
    trackId: string,
    importance: number,
    reason: string,
    bestEventId?: string,
  ): Promise<void> {
    const active = this.active.get(trackId)
    if (active) {
      active.importance = importance
      active.importanceReason = reason
      if (bestEventId !== undefined) active.bestEventId = bestEventId
    }
    const data: Record<string, unknown> = { importance, importanceReason: reason }
    if (bestEventId !== undefined) data['bestEventId'] = bestEventId
    try {
      await this.store.update.mutate({ collection: TRACKS_COLLECTION, id: trackId, data })
    } catch (err) {
      this.logger.warn('setImportance persist failed', { meta: { trackId, error: String(err) } })
    }
  }

  /**
   * Apply a PARTIAL patch of the per-track operator state (`markForTrain`,
   * `debug`). Mirrors `setLabel`'s dual write — in-RAM active entry AND the
   * persisted row — so a mark set on a LIVE track is carried into
   * `persistCompleted` at expiry instead of evaporating with the RAM state.
   *
   * `markForTrain` is a LIFECYCLE move, not a boolean write: `true` is
   * `→ staging`, `false` is `→ none`. This method does not police the move —
   * the `trained` refusal lives in `applyTrackFlags`, the single cap-level write
   * surface, which is the only caller that has already read the current state.
   *
   * An omitted key is left untouched; `false` is WRITTEN, not dropped, so an
   * explicitly un-marked track stays distinguishable from one never touched.
   * An empty patch is a no-op (an update with no columns is not a useful
   * statement, and the store would reject or silently ignore it).
   */
  async setFlags(trackId: string, patch: TrackFlagsPatch): Promise<void> {
    const data: Record<string, boolean | string> = {}
    const nextStatus: RetrainStatus | undefined =
      patch.markForTrain === undefined ? undefined : patch.markForTrain ? 'staging' : 'none'
    if (nextStatus !== undefined) data['retrainStatus'] = nextStatus
    if (patch.debug !== undefined) data['debug'] = patch.debug
    // `''` is a WRITE, not an omission — clearing the note is how a debug flag
    // going off takes its question with it (see `applyTrackFlags`), so the
    // emptiness must reach the column instead of being filtered out as falsy.
    if (patch.debugNote !== undefined) data['debugNote'] = patch.debugNote
    if (patch.favourited !== undefined) data['favourited'] = patch.favourited
    if (Object.keys(data).length === 0) return
    const active = this.active.get(trackId)
    if (active) {
      if (nextStatus !== undefined) active.retrainStatus = nextStatus
      if (patch.debug !== undefined) active.debug = patch.debug
      if (patch.debugNote !== undefined) active.debugNote = patch.debugNote
      if (patch.favourited !== undefined) active.favourited = patch.favourited
    }
    try {
      await this.store.update.mutate({ collection: TRACKS_COLLECTION, id: trackId, data })
    } catch (err) {
      // Not silent: an operator toggle that did not reach disk must leave a
      // line, or "I marked it and it came back unmarked" has no evidence.
      this.logger.warn('setFlags persist failed', { meta: { trackId, error: String(err) } })
    }
  }

  /**
   * Pin or release tracks for a PROMOTED tracking-tape window (D681). Dual
   * write like `setFlags`: the RAM entry of a live track carries it into
   * `persistCompleted`.
   *
   * The persisted half is SET-BASED and writes only DRIFT (Task 12 fix round
   * 3, D447): one `UPDATE … WHERE deviceId = ? AND id IN (…) AND <not already
   * in that state>` per {@link BENCH_PIN_CHUNK} ids, on the primary key. The
   * pin reconcile re-applies every promotion's pins on each operator action
   * and at hub start, and `hub/sqlite-settings` is one synchronous thread: a
   * reconcile with nothing drifted must write zero rows, not rewrite 3 000.
   * "Not already pinned" is NULL-safe (`whereNot`), so a row that predates
   * the column is pinned; "already unpinned" includes NULL, so an unpin never
   * writes a row that was never pinned.
   *
   * Returns how many of `trackIds` are now in the asked state — every id of a
   * chunk whose statement succeeded (an id with no row, or already in state,
   * needs no write). A failed chunk is logged, tagged, and not counted, so the
   * caller sees a short count and keeps the promotion owed.
   */
  async setBenchPinned(
    deviceId: number,
    trackIds: readonly string[],
    pinned: boolean,
  ): Promise<number> {
    for (const trackId of trackIds) {
      const active = this.active.get(trackId)
      if (active) active.benchPinned = pinned
    }
    let covered = 0
    for (let i = 0; i < trackIds.length; i += BENCH_PIN_CHUNK) {
      const chunk = trackIds.slice(i, i + BENCH_PIN_CHUNK)
      try {
        await this.store.updateWhere.mutate({
          collection: TRACKS_COLLECTION,
          filter: pinned
            ? { where: { deviceId }, whereIn: { id: [...chunk] }, whereNot: { benchPinned: true } }
            : { where: { deviceId, benchPinned: true }, whereIn: { id: [...chunk] } },
          data: { benchPinned: pinned },
        })
        covered += chunk.length
      } catch (err) {
        this.logger.warn('setBenchPinned persist failed', {
          tags: { deviceId },
          meta: { tracks: chunk.length, pinned, error: String(err) },
        })
      }
    }
    return covered
  }

  /**
   * Record that a face DETECTOR found a face on this track. Set-once, never
   * cleared, and deliberately NOT part of {@link setFlags}: that method is the
   * operator's write surface and this is the pipeline's.
   *
   * **The signal is detection, not recognition.** The caller is the detail-route
   * fan-out, keyed on the detail's own `className === 'face'` — BEFORE the
   * `minFacePx` gate, before the recognizer is consulted, and regardless of
   * whether face recognition is enabled at all. That is the whole point: the
   * viewer's "face present, identity unknown" badge is `hasFace && !subLabel`,
   * and a flag that only fired when the recognizer answered would be true
   * exactly when the badge must not show.
   *
   * **Idempotent, and it does not write per detail.** A face detail lands many
   * times over a track's life. While the track is LIVE the flag is set in RAM
   * only and rides `persistCompleted` at expiry — one row write, not one per
   * frame. Once the flag is set, every later call returns immediately.
   *
   * The persisted patch is for the LATE detail: enrichment answers routinely
   * arrive after the track has expired, when there is no RAM entry left and the
   * row is the only thing to correct. Best-effort — a failed patch costs a badge,
   * never a track.
   */
  async markFaceDetected(trackId: string): Promise<void> {
    const active = this.active.get(trackId)
    if (active) {
      if (active.hasFace === true) return
      active.hasFace = true
      return
    }
    try {
      await this.store.update.mutate({
        collection: TRACKS_COLLECTION,
        id: trackId,
        data: { hasFace: true },
      })
    } catch (err) {
      this.logger.warn('markFaceDetected persist failed', {
        meta: { trackId, error: String(err) },
      })
    }
  }

  /**
   * Record that a face row LANDED in the gallery for this track — a crop AND an
   * embedding, i.e. a face an operator could ASSIGN to an identity.
   *
   * The STRICT twin of {@link markFaceDetected}: same set-once semantics, same
   * live-then-persisted branch, same best-effort failure. What differs is WHERE
   * it is called from, and that is the entire point of the pair. `hasFace` is
   * stamped at the top of the face branch, before every gate, so it says only
   * "a detector fired". This is stamped by `FaceRecognizer.onTrackEnd` AFTER
   * `faceStore.insert` resolved — past the embedding-magnitude verdict, the
   * `minFacePx` gate, the candidate gate, the imageless-track drop and the
   * crop-store drop. Every one of those can legitimately refuse the face, so a
   * mark written any earlier tells the operator a face is assignable when the
   * gallery holds nothing to assign.
   *
   * **Not gated on recognition.** A face collected but never auto-matched is
   * still assignable — it is the case an operator most wants to act on — so the
   * writer does not consult `recognizedIdentityId`.
   *
   * **The persisted branch is the ORDINARY path here, not the exotic one.**
   * `onTrackEnd` runs at close, by which time the track has usually already
   * been written and has no RAM entry left; the live branch only catches the
   * races where it has not. Best-effort in both: a failed patch costs a badge,
   * never a track — but it is LOGGED, because a mark that silently did not
   * reach disk reads afterwards as "this track never had a gallery face".
   */
  /**
   * Persist (or CLEAR, with `null`) the row's `previewMissReason` (D276/B2).
   * Runs against the PERSISTED row only — the close path calls it after
   * `expireStale` wrote the row, and the late-keyFrame upgrade clears it on a
   * row that closed long ago. THROWS on a failed write: the caller owns the
   * log line (it has the deviceId this store method does not).
   */
  async setPreviewMiss(trackId: string, reason: string | null): Promise<void> {
    await this.store.update.mutate({
      collection: TRACKS_COLLECTION,
      id: trackId,
      data: { previewMissReason: reason },
    })
  }

  async markEmbeddedFace(trackId: string): Promise<void> {
    const active = this.active.get(trackId)
    if (active) {
      if (active.hasEmbeddedFace === true) return
      active.hasEmbeddedFace = true
      return
    }
    try {
      await this.store.update.mutate({
        collection: TRACKS_COLLECTION,
        id: trackId,
        data: { hasEmbeddedFace: true },
      })
    } catch (err) {
      this.logger.warn('markEmbeddedFace persist failed', {
        meta: { trackId, error: String(err) },
      })
    }
  }

  /**
   * Record that a rider was folded into THIS vehicle subject (D34).
   *
   * The twin of {@link markFaceDetected}, deliberately: same set-once
   * semantics, same live-then-persisted branch, same best-effort failure. What
   * it closes is a record gap — the fold deletes the person detection before the
   * tracker, and until this method existed nothing durable said so, while both
   * the ADR and the code comment claimed otherwise.
   *
   * Set-once and never cleared: the fold is a fact about a moment of the
   * track's life, and a rider who dismounts later does not un-ride the frames
   * where they were riding. (The dismount itself needs nothing here — the fold
   * is per-FRAME, so the person simply stops overlapping and spawns its own
   * track, which is D34's whole design.)
   */
  async markRiderFolded(trackId: string): Promise<void> {
    const active = this.active.get(trackId)
    if (active) {
      if (active.hasRider === true) return
      active.hasRider = true
      return
    }
    try {
      await this.store.update.mutate({
        collection: TRACKS_COLLECTION,
        id: trackId,
        data: { hasRider: true },
      })
    } catch (err) {
      this.logger.warn('markRiderFolded persist failed', {
        meta: { trackId, error: String(err) },
      })
    }
  }

  /**
   * Write the retrain LIFECYCLE state directly — the move `setFlags` cannot
   * express.
   *
   * `setFlags` takes a BOOLEAN patch and therefore reaches only `staging` and
   * `none`; `'trained'` has no boolean that means it, which is exactly why D81
   * left the third state unreachable until its consumer existed. This is that
   * consumer's write, and it is deliberately NOT reachable from the generic
   * toggle: the only callers are the retrain page's `complete` and `restage`,
   * both of which have already read the current state and decided the move is
   * legal (`retrain/retrain-lifecycle.ts`).
   *
   * Dual write, exactly like `setFlags`: the in-RAM active entry as well as the
   * row, so a status set on a still-live track survives its expiry-time
   * persist instead of being overwritten by the stale RAM copy.
   */
  async setRetrainStatus(trackId: string, status: RetrainStatus): Promise<void> {
    const active = this.active.get(trackId)
    if (active) active.retrainStatus = status
    try {
      await this.store.update.mutate({
        collection: TRACKS_COLLECTION,
        id: trackId,
        data: { retrainStatus: status },
      })
    } catch (err) {
      // Never silent: a completion that did not reach disk leaves the track
      // pinned for ever with the UI reporting it done.
      this.logger.warn('setRetrainStatus persist failed', {
        meta: { trackId, status, error: String(err) },
      })
      throw err
    }
  }

  /**
   * Resolved operator state for a track — active entry first, then the
   * persisted row. `null` when the track is unknown to both.
   *
   * Reports the LIFECYCLE STATUS, not the derived boolean, because the one
   * caller that matters decides on it: `applyTrackFlags` must tell `trained`
   * (refuse the write) from `none` (accept it), and both report
   * `markForTrain: false`. Absent collapses to `'none'` / `false` — the
   * "never touched" tri-state exists only in RAM and carries no decision.
   */
  async readFlags(trackId: string): Promise<ResolvedTrackFlags | null> {
    const active = this.active.get(trackId)
    if (active) {
      return {
        retrainStatus: active.retrainStatus ?? 'none',
        debug: active.debug === true,
        debugNote: active.debugNote ?? '',
        favourited: active.favourited === true,
        startedAt: active.firstSeen,
        className: active.className,
        ...(displayLabel(active) !== undefined ? { label: displayLabel(active) } : {}),
      }
    }
    const persisted = await this.getPersistedByTrackId(trackId)
    if (!persisted) return null
    return {
      retrainStatus: persisted.retrainStatus ?? 'none',
      debug: persisted.debug === true,
      debugNote: persisted.debugNote ?? '',
      favourited: persisted.favourited === true,
      startedAt: persisted.firstSeen,
      className: persisted.className,
      ...(displayLabel(persisted) !== undefined ? { label: displayLabel(persisted) } : {}),
    }
  }

  /**
   * Clear a track's label. Sets label to null in the persisted row (so
   * rowToTrack's `typeof label === 'string'` guard omits it on read → label
   * is absent/undefined). Also clears the in-memory active entry if present.
   */
  async clearLabel(trackId: string, tier: LabelTier): Promise<void> {
    const active = this.active.get(trackId)
    if (active) {
      if (tier === 1) {
        delete active.label
        delete active.labelScore
        delete active.labelMeta
      } else {
        delete active.subLabel
        delete active.subLabelScore
        delete active.subLabelMeta
      }
      // A retracted identity must reach a grouped window too (D692, D665): a
      // one-shot message must never name an identity the recogniser took back.
      this.notifyLabelChanged(active, 'cleared')
    }
    try {
      await this.store.update.mutate({
        collection: TRACKS_COLLECTION,
        id: trackId,
        data:
          tier === 1
            ? { label: null, labelScore: null, labelMeta: null }
            : { subLabel: null, subLabelScore: null, subLabelMeta: null },
      })
    } catch (err) {
      this.logger.warn('clearLabel persist failed', {
        ...(active !== undefined ? { tags: { deviceId: active.deviceId } } : {}),
        meta: { trackId, error: String(err) },
      })
    }
  }

  /** Discard active tracks for a device without persisting (used on
   *  operator clearTracks / device unregistration). */
  clearDevice(deviceId: number): void {
    for (const [trackId, t] of this.active) {
      if (t.deviceId === deviceId) this.active.delete(trackId)
    }
    // Membership is keyed by survivor, which may have no row of its own.
    for (const [survivorId, m] of this.members) {
      if (m.deviceId === deviceId) this.members.delete(survivorId)
    }
  }

  clearAll(): void {
    this.active.clear()
    this.closedRows.clear()
    this.members.clear()
  }

  /**
   * Drop a single active track WITHOUT persisting it as a historical row. Used
   * when a track is PROMOTED to a stationary-object registry entry: the durable
   * record for a parked object is the registry entry, not a Track, so the track
   * must NOT land in the key-event feed. No-op for an unknown/expired track.
   */
  dropActive(trackId: string): void {
    this.active.delete(trackId)
    // Nothing closes under it — a retracted or promoted track's members are
    // released with it (D683 Task 18; the cascade owns what they wrote).
    this.members.delete(trackId)
    // D683 review N8: an id held past TTL by `canClose` and then dropped (a
    // stationary promotion's disposal) must not linger in the held-row
    // sampling memory forever — it is never coming back to release itself.
    this.heldRows.delete(trackId)
  }

  /**
   * Close a still-ACTIVE track NOW: persist its row, then drop the in-RAM
   * entry. The early-close counterpart of {@link expireStale}, for a caller
   * that knows the track is over before its TTL says so.
   *
   * **This exists because {@link dropActive} orphans everything the track
   * owns.** A track's media, object events and CLIP vector are keyed by trackId
   * and written throughout its life; the ROW is what retention cascades from,
   * and it is written only here or at expiry. Forgetting a lived-in track
   * therefore leaves a full media set — key frame, thumbnail, first/last frame,
   * the snapshot filmstrip — with no owner any sweep can ever reach. Measured on
   * the live hub 2026-08-14: 74,700 such media rows, 18.9 GB, growing
   * ~1.15 GB/day, plus 23,296 object events and 4,543 CLIP vectors (D161).
   *
   * `dropActive` is still correct for a birth RETRACTED before it lived —
   * nothing has been written under that id yet. It is never correct for a track
   * that ran.
   *
   * **The row SAYS why it was closed early** (`reason` → the `closedReason`
   * column). Persisting a promoted track put its footprint back under the
   * retention sweep, and it also put the parked car back in front of every
   * consumer that reads the window's tracks: the operator's nightly digest went
   * from 1-2 tiles to 10, most of them the same stationary car. The marker is
   * written HERE, at the one place that knows, so a consumer can ask for
   * passages exactly instead of guessing at movement from a stored trajectory.
   *
   * Returns whether an active entry was found. THROWS if the persist fails: the
   * caller must log it, because a swallowed failure here IS the leak.
   */
  async closeActive(trackId: string, reason: TrackCloseReason): Promise<boolean> {
    const t = this.active.get(trackId)
    if (t === undefined) return false
    t.active = false
    t.closedReason = reason
    const record = cloneTrack(t)
    await this.persistCompleted(record)
    this.active.delete(trackId)
    this.heldRows.delete(trackId)
    this.noteRowClosed(trackId, Date.now())
    return true
  }

  /** Delete the persisted track row (keyed by trackId) and drop the in-RAM
   *  active entry if present. Used by the whole-track deletion cascade. */
  async deletePersisted(trackId: string): Promise<void> {
    await this.store.delete.mutate({ collection: TRACKS_COLLECTION, key: trackId })
    this.active.delete(trackId)
    this.heldRows.delete(trackId)
    // A DELETED row owns nothing new either: media written under this id after
    // the cascade would be an orphan no sweep can reach.
    this.noteRowClosed(trackId, Date.now())
  }

  /**
   * A page of persisted track ids for a device whose `lastSeen < cutoffMs`
   * (exclusive), oldest first. Feeds the `pruneTracksBefore` drain loop: the
   * caller cascades the returned ids (which deletes their rows) and calls again
   * until an empty page. Backed by `idx_tracks_device_lastSeen`.
   *
   * **`offset` is what makes the drain tolerate a row it will not delete.**
   * Without it the loop re-reads the same head of the result set forever, so a
   * single undeletable track either spins it or — with the "a non-empty page
   * deleted nothing, stop" guard — halts retention FOR THAT DEVICE, leaving
   * every unflagged track behind it to accumulate (D59). The caller advances
   * `offset` by the number of rows a page did NOT remove, which terminates
   * because the offset only grows and the result set is finite.
   *
   * This is the seam the retention PIN lands on, and it lands here ONLY: after
   * D61 the track row is the single cascading root, so one exemption on this one
   * query holds the track's events, crops, keyframes and CLIP vector with it —
   * where D59 had to plan for four exemptions across four disagreeing sweeps.
   * The pin is `whereIn: { retrainStatus: ['none','trained'] }` below (D81).
   *
   * Filter shape mirrors `EventStore.pruneBefore`: inclusive `[0, cutoffMs - 1]`
   * → strictly `< cutoffMs`. Best-effort — a query failure yields [].
   */
  async listIdsBefore(
    deviceId: number,
    cutoffMs: number,
    limit: number,
    offset = 0,
  ): Promise<readonly string[]> {
    try {
      const rows = await this.store.query.query({
        collection: TRACKS_COLLECTION,
        filter: {
          // The two EVICTABLE lifecycle states, named positively (D81). It is
          // part of the SELECT, not a post-filter, and that is not a style
          // choice: `pruneTracksBefore` drains by re-querying until a page comes
          // back empty and stops when a non-empty page deletes nothing, so a
          // held row removed after the query would be returned forever — the
          // loop would either spin or halt the sweep for the device, letting
          // unflagged debris pile up behind the pin. Excluded in SQL, a
          // `staging` row is simply never a candidate.
          //
          // `trained` IS here on purpose: the retrain page copies the frames it
          // selects, so a trained track's media has no further claim on the
          // disk. Writing this as "everything except staging" is impossible —
          // the filter language has no negation — and that impossibility is why
          // the column is NOT NULL DEFAULT 'none': a NULL would match neither
          // value and the whole pre-column history would be immortal.
          where: { deviceId },
          whereIn: { retrainStatus: ['none', 'trained'] },
          // NULL-safe: keeps absent/false, excludes only explicit `true`.
          // A favourited+trained track must still be held (boolean pin, not
          // a lifecycle — `trained` alone is evictable). `benchPinned` is the
          // same kind of boolean pin (D681).
          whereNot: { favourited: true, benchPinned: true },
          whereBetween: { lastSeen: [0, cutoffMs - 1] },
          orderBy: { field: 'lastSeen', direction: 'asc' },
          limit,
          offset,
        },
      })
      return rows.map((r) => r.id).filter((id): id is string => typeof id === 'string')
    } catch (err) {
      this.logger.warn('TrackStore.listIdsBefore failed', {
        tags: { deviceId },
        meta: { deviceId, cutoffMs, offset, error: String(err) },
      })
      return []
    }
  }

  /**
   * Every persisted track id for the device, including favourited and staging.
   *
   * Disk reconcile is not age retention: a pin against `listIdsBefore` must not
   * keep a ghost whose blobs are gone. Paged oldest-first so a caller can drain.
   */
  async listIdsForDevice(deviceId: number, limit: number, offset = 0): Promise<readonly string[]> {
    try {
      const rows = await this.store.query.query({
        collection: TRACKS_COLLECTION,
        filter: {
          where: { deviceId },
          orderBy: { field: 'lastSeen', direction: 'asc' },
          limit,
          offset,
        },
      })
      return rows.map((r) => r.id).filter((id): id is string => typeof id === 'string')
    } catch (err) {
      this.logger.warn('TrackStore.listIdsForDevice failed', {
        tags: { deviceId },
        meta: { deviceId, offset, error: String(err) },
      })
      return []
    }
  }

  /**
   * The device's STAGING tracks, newest first — the training-export selection.
   *
   * `retrainStatus = 'staging'` is exactly the complement of the sweep's
   * `whereIn ['none','trained']` (all three safe against NULL because the column
   * is NOT NULL DEFAULT 'none') — the load-bearing part: this is the set
   * retention has promised to still be there. `trained` is deliberately NOT in
   * it: the sweep is free to delete a trained track mid-pass, and exporting one
   * is how a manifest ends up describing files the archive does not contain.
   *
   * `projection: 'slim'` because an export enumerates media; it has no use for
   * the per-frame trajectory JSON, which is the heaviest column on the row.
   */
  async listStaging(deviceId: number, limit: number): Promise<readonly Track[]> {
    try {
      const rows = await this.store.query.query({
        collection: TRACKS_COLLECTION,
        filter: {
          where: { deviceId, retrainStatus: 'staging' },
          orderBy: { field: 'lastSeen', direction: 'desc' },
          limit,
        },
        ...projectionArg('slim'),
      })
      return rows
        .filter((r): r is typeof r & { id: string } => typeof r.id === 'string')
        .map((r) => this.rowToTrack(r.id, r.data, 'slim'))
    } catch (err) {
      this.logger.warn('TrackStore.listStaging failed', {
        tags: { deviceId },
        meta: { deviceId, limit, error: String(err) },
      })
      return []
    }
  }

  /**
   * The device's DEBUG-marked tracks, newest first — the Events → Debug tab.
   *
   * Two things about this query are load-bearing.
   *
   * **`where: { debug: true }` matches only the explicit `true`.** The column is
   * nullable with no default (unlike `retrainStatus`), so a row that was never
   * marked holds NULL and positive equality skips it — which is exactly the set
   * wanted here, and the reason the column was left nullable in the first place.
   *
   * **The result is re-checked in memory.** `compileFilter` DROPS a predicate
   * whose column does not exist in SQLite — an older hub whose `declareCollection`
   * fingerprint never re-ran would answer this query with EVERY track on the
   * camera, silently, and the tab would present the whole history as
   * operator-marked. A skipped predicate is indistinguishable from a matching one
   * at the wire, so the guard is the only thing that can tell them apart.
   *
   * **`projection: 'slim'`, and this is the expensive detail.** `positions` is a
   * JSON column averaging ~10 KB a row, and `'full'` parses it for every row
   * returned. That is affordable for a handful of marked tracks and ruinous in
   * the case this method already defends against: if the predicate is dropped,
   * the store hands back `limit` rows PER CAMERA and the trajectory of the
   * camera's whole recent history is parsed before the guard below throws it
   * away. The cheap question comes first (D56) — the list carries no trajectory,
   * and the per-track analysis reads the one row it needs through
   * `getPersistedByTrackId`.
   */
  async listDebug(deviceId: number, limit: number): Promise<readonly Track[]> {
    try {
      const rows = await this.store.query.query({
        collection: TRACKS_COLLECTION,
        filter: {
          where: { deviceId, debug: true },
          orderBy: { field: 'lastSeen', direction: 'desc' },
          limit,
        },
        ...projectionArg('slim'),
      })
      const tracks = rows
        .filter((r): r is typeof r & { id: string } => typeof r.id === 'string')
        .map((r) => this.rowToTrack(r.id, r.data, 'slim'))
      const marked = tracks.filter((t) => t.debug === true)
      if (marked.length !== tracks.length) {
        // Said out loud with the deviceId: the alternative is a tab that quietly
        // lists a camera's whole history and looks like a marking bug.
        this.logger.warn(
          'TrackStore.listDebug — the store returned unmarked rows; the `debug` predicate was not applied',
          {
            tags: { deviceId },
            meta: { deviceId, returned: tracks.length, marked: marked.length },
          },
        )
      }
      return marked
    } catch (err) {
      this.logger.warn('TrackStore.listDebug failed', {
        tags: { deviceId },
        meta: { deviceId, limit, error: String(err) },
      })
      return []
    }
  }

  /**
   * How many of this device's tracks are STAGING — optionally only those older
   * than a cutoff, i.e. exactly the rows a sweep just declined to touch.
   *
   * Two callers, one query. The sweep uses `olderThanMs` for its report; the
   * `setTrackFlags` body uses the unbounded form to enforce the per-device
   * staging budget, because staging is unbounded in TIME by construction and
   * something has to bound it in COUNT (D81, and D59 asked for exactly this).
   * `trained` tracks are NOT counted — they are evictable again, so they cost
   * the budget nothing.
   *
   * Best-effort — a failure reports 0 rather than disturbing the caller. The
   * budget check reads that as "there is room", which is the safe direction: a
   * failed count must not stop an operator marking a track.
   */
  async countStaging(query: StagingCountQuery): Promise<number> {
    const { deviceId, olderThanMs } = query
    try {
      return await this.store.count.query({
        collection: TRACKS_COLLECTION,
        filter: {
          where: { deviceId, retrainStatus: 'staging' },
          ...(olderThanMs !== undefined
            ? { whereBetween: { lastSeen: [0, olderThanMs - 1] } }
            : {}),
        },
      })
    } catch (err) {
      this.logger.warn('TrackStore.countStaging failed', {
        tags: { deviceId },
        meta: { deviceId, olderThanMs, error: String(err) },
      })
      return 0
    }
  }

  /**
   * How many of this device's tracks are FAVOURITED — optionally only those
   * older than a cutoff, i.e. the rows a sweep just declined to touch because
   * of the boolean pin (independent of `retrainStatus`).
   *
   * Mirrors {@link countStaging}: the sweep log must name held work or a
   * favourited-only camera reads as "retention did nothing". Best-effort — a
   * failure reports 0 rather than disturbing the caller.
   */
  async countFavourited(query: StagingCountQuery): Promise<number> {
    const { deviceId, olderThanMs } = query
    try {
      return await this.store.count.query({
        collection: TRACKS_COLLECTION,
        filter: {
          where: { deviceId, favourited: true },
          ...(olderThanMs !== undefined
            ? { whereBetween: { lastSeen: [0, olderThanMs - 1] } }
            : {}),
        },
      })
    } catch (err) {
      this.logger.warn('TrackStore.countFavourited failed', {
        tags: { deviceId },
        meta: { deviceId, olderThanMs, error: String(err) },
      })
      return 0
    }
  }

  /**
   * How many of this device's tracks are pinned by a PROMOTED tracking-tape
   * window (D681) — optionally only those older than a cutoff, i.e. the rows a
   * sweep just declined to touch because of the boolean pin.
   *
   * Mirrors {@link countFavourited}: the sweep log must name held work or a
   * bench-pinned-only camera reads as "retention did nothing". Best-effort — a
   * failure reports 0 rather than disturbing the caller.
   */
  async countBenchPinned(query: StagingCountQuery): Promise<number> {
    const { deviceId, olderThanMs } = query
    try {
      return await this.store.count.query({
        collection: TRACKS_COLLECTION,
        filter: {
          where: { deviceId, benchPinned: true },
          ...(olderThanMs !== undefined
            ? { whereBetween: { lastSeen: [0, olderThanMs - 1] } }
            : {}),
        },
      })
    } catch (err) {
      this.logger.warn('TrackStore.countBenchPinned failed', {
        tags: { deviceId },
        meta: { deviceId, olderThanMs, error: String(err) },
      })
      return 0
    }
  }

  /**
   * The SUBSET of `trackIds` that still have a persisted row — the orphan
   * audit's liveness probe.
   *
   * THROWS on a query failure rather than answering partially: a probe that
   * quietly under-reports reads as "these tracks are gone", and the caller
   * deletes live media, events and vectors on the strength of it. Every other
   * read on this store is best-effort and swallows; this one must not, and the
   * difference is the whole reason it is a separate method.
   *
   * **The ACTIVE (in-RAM, not yet persisted) tracks count as existing.** A
   * track is promoted to a persisted row only when it ends, so a running track
   * has media, events and a vector on disk with no row behind them. Answering
   * from the table alone would call all of that orphaned and delete a camera's
   * current subject out from under it. The orphan audit's grace window would
   * hide this for an hour and then stop hiding it.
   */
  async existingTrackIds(trackIds: readonly string[]): Promise<ReadonlySet<string>> {
    const PAGE = 500
    const found = new Set<string>()
    for (const id of trackIds) {
      if (this.active.has(id)) found.add(id)
    }
    for (let i = 0; i < trackIds.length; i += PAGE) {
      const chunk = trackIds.slice(i, i + PAGE)
      if (chunk.length === 0) continue
      const rows = await this.store.query.query({
        collection: TRACKS_COLLECTION,
        filter: { whereIn: { id: [...chunk] }, limit: chunk.length },
      })
      for (const row of rows) found.add(row.id)
    }
    return found
  }

  /**
   * The SUBSET of `trackIds` that are PINNED — `retrainStatus: 'staging'`,
   * `favourited: true`, or `benchPinned: true` (a promoted tracking-tape
   * window, D681).
   *
   * A pin is the operator saying "keep this one". It is enforced against the
   * age sweep (`listIdsBefore` excludes both), and it must be enforced against
   * a bulk reclaim for exactly the same reason: a starred track whose
   * filmstrip is gone is a pin that did not hold.
   *
   * **The ACTIVE (in-RAM) tracks count as pinned here.** A running track has
   * no persisted row yet, so the table cannot answer for it; treating an
   * unanswerable id as unpinned would delete the media of the camera's current
   * subject. Unknown means protected — the inverse of {@link existingTrackIds},
   * where unknown means alive, and the same safe direction.
   *
   * THROWS on a query failure. A probe that quietly under-reports here reads as
   * "nothing is pinned".
   */
  async pinnedTrackIds(trackIds: readonly string[]): Promise<ReadonlySet<string>> {
    const PAGE = 500
    const found = new Set<string>()
    for (const id of trackIds) {
      if (this.active.has(id)) found.add(id)
    }
    for (let i = 0; i < trackIds.length; i += PAGE) {
      const chunk = trackIds.slice(i, i + PAGE)
      if (chunk.length === 0) continue
      const [staging, favourited, benchPinned] = await Promise.all([
        this.store.query.query({
          collection: TRACKS_COLLECTION,
          columns: ['id'],
          filter: {
            whereIn: { id: [...chunk] },
            where: { retrainStatus: 'staging' },
            limit: chunk.length,
          },
        }),
        this.store.query.query({
          collection: TRACKS_COLLECTION,
          columns: ['id'],
          filter: {
            whereIn: { id: [...chunk] },
            where: { favourited: true },
            limit: chunk.length,
          },
        }),
        this.store.query.query({
          collection: TRACKS_COLLECTION,
          columns: ['id'],
          filter: {
            whereIn: { id: [...chunk] },
            where: { benchPinned: true },
            limit: chunk.length,
          },
        }),
      ])
      for (const row of staging) found.add(row.id)
      for (const row of favourited) found.add(row.id)
      for (const row of benchPinned) found.add(row.id)
    }
    return found
  }

  /**
   * The distinct set of deviceIds that currently have persisted tracks. Feeds
   * the per-device retention sweep (design §6) so a device that stopped
   * producing frames still has its aged track debris pruned. Paged scan +
   * in-memory dedup (the query cap has no DISTINCT); best-effort.
   */
  async listDeviceIds(): Promise<readonly number[]> {
    return this.collectDeviceIds(0)
  }

  /**
   * Distinct deviceIds with a persisted track whose `lastSeen` is at least
   * `since`. The group sealer's 10-minute window. Walking from epoch 0 is how
   * `sealRecent` wedged hub-main every TTL sweep.
   */
  async listDeviceIdsSince(since: number): Promise<readonly number[]> {
    return this.collectDeviceIds(Math.max(0, Math.floor(since)))
  }

  /**
   * The distinct `deviceId`s with a track at or after `fromLastSeen`.
   *
   * ## Why this is a histogram and not a paged read
   *
   * It used to drain the table in 501-row pages on a `lastSeen` range with no
   * `deviceId`, ordered by `lastSeen`. The indexes on this table are
   * `(deviceId, lastSeen)` and `(deviceId, firstSeen)` — neither can serve a
   * `lastSeen` range from the left — so `EXPLAIN QUERY PLAN` on the live
   * database answered:
   *
   * ```
   * SCAN pipeline-analytics:tracks
   * USE TEMP B-TREE FOR ORDER BY
   * ```
   *
   * A full scan of a 155 MB table, plus a sorter holding every matching row —
   * and the store has no column projection, so each row carries its ~8.5 KB
   * `positions`/`snapshots` JSON through the sort. PER PAGE. Draining 17 940
   * rows took 36 such pages: measured on a copy of the live database, 36 full
   * scans, and on the hub itself single statements of 1 196–1 101 ms each,
   * every one of them blocking the one synchronous thread the whole cluster
   * reads configuration through. `listDeviceIds` has ~10 callers.
   *
   * The answer being asked for is at most a couple of dozen integers. A
   * histogram on `deviceId` with `bucketSize: 1` is `GROUP BY deviceId`, and
   * the planner serves it from an index that already exists:
   *
   * ```
   * SCAN pipeline-analytics:tracks USING COVERING INDEX idx_tracks_device_lastSeen
   * USE TEMP B-TREE FOR GROUP BY
   * ```
   *
   * 384 KB of index instead of 155 MB of table, ONE statement instead of 36:
   * **6.0 ms against 678 ms** on the same copy, warm cache both times. No new
   * index, so no write amplification and no extra bytes — the cheap question
   * came first, it just was not being asked (D56).
   *
   * `bucket` IS the deviceId: the column is INTEGER and the bucket expression
   * is `CAST((deviceId - 0) / 1 AS INTEGER)`. Best-effort, as before — a
   * failure yields [] and the caller treats it as "no devices", which is the
   * same answer it got from a failed page.
   */
  private async collectDeviceIds(fromLastSeen: number): Promise<readonly number[]> {
    try {
      const buckets = await this.store.histogram.query({
        collection: TRACKS_COLLECTION,
        field: 'deviceId',
        bucketSize: 1,
        origin: 0,
        // Omitted entirely at epoch 0: an unfiltered GROUP BY is served from
        // the covering index alone, while a range that matches everything
        // still makes the planner consider the table.
        ...(fromLastSeen > 0
          ? { filter: { whereBetween: { lastSeen: [fromLastSeen, Number.MAX_SAFE_INTEGER] } } }
          : {}),
      })
      const ids: number[] = []
      for (const b of buckets) {
        if (b.count > 0 && Number.isFinite(b.bucket)) ids.push(b.bucket)
      }
      return ids
    } catch (err) {
      this.logger.warn('TrackStore.listDeviceIds failed', { meta: { error: String(err) } })
      return []
    }
  }

  /** Historical query — hits the persisted collection. With `zone` set,
   *  candidates are SQL-prefiltered on the envelope columns (overlap test via
   *  `whereBetween`), NULL-envelope rows are re-fetched separately (they must
   *  still MATCH — `BETWEEN` excludes NULL), and survivors run the precise
   *  per-position test against the zone. `projection: 'slim'` drops the heavy
   *  `positions[]` / `snapshots[]` JSON from the returned rows (empty arrays);
   *  the zone test still runs on the stored positions before the drop. */
  async queryHistorical(params: {
    deviceId: number
    since?: number
    until?: number
    limit?: number
    zone?: TrackZoneFilter
    projection?: TrackProjection
    /** Exclude stationary-promoted rows (the events-page contract). Default
     *  false: internal readers (retention, forensics) see every row. */
    excludeStationaryPromotions?: boolean
    /**
     * Restrict to these track classes. ABSENT or EMPTY means no filter.
     *
     * Empty is "show all" and not "nothing matches", because that is what the
     * UI means by it: a chip row with nothing selected is an operator who has
     * not narrowed anything, and answering with an empty timeline would read as
     * a camera that saw nothing all day.
     *
     * Filtered on the `classes` ARRAY, not on `className`. Measured on the
     * live hub over 24 h (devices 102/101/104, 1021 tracks): 0.5% of tracks
     * carry a class their `className` does not name — animal/person on 104,
     * i.e. exactly the ambiguous rows a narrowing question is asked about. A
     * `whereIn className` would have hidden them while looking like it worked.
     *
     * It is a SUPERSET prefilter: the 5.5% of rows with no usable `classes[]`
     * are KEPT, and the client's exact rule still runs — the same division of
     * labour the zone filter already uses (server prefilters on the persisted
     * envelope, client does the per-position test). The read still loses ~94%
     * of what cannot match, which is what makes it fast.
     */
    classes?: readonly string[]
    /**
     * Track SOURCES to leave out — see `ExcludeSourcesDoc` in the cap. ABSENT
     * or EMPTY excludes nothing. Compiled by {@link trackSourceFilter} into an
     * EXACT predicate on the nullable `source` column, never a superset: this
     * is the one filter a client uses to say "not the synthetic projections",
     * and a filter that quietly kept them is the defect it exists to fix.
     */
    excludeSources?: readonly TrackSource[]
  }): Promise<readonly PersistedTrack[]> {
    const limit = params.limit ?? 50
    const timeBetween: Record<string, [unknown, unknown]> =
      params.since !== undefined || params.until !== undefined
        ? { firstSeen: [params.since ?? 0, params.until ?? Date.now()] }
        : {}
    // NULL-safe: rows written before `closedReason` existed (or closed
    // normally) carry NULL and must survive the exclusion.
    const stationaryExclusion =
      params.excludeStationaryPromotions === true
        ? { whereNot: { closedReason: 'stationary-promotion' } }
        : {}
    const classFilter =
      params.classes !== undefined && params.classes.length > 0
        ? { whereJsonArrayAny: { classes: [...params.classes] } }
        : {}
    const source = trackSourceFilter(params.excludeSources)
    // Every known source excluded. Not a no-op filter: the caller asked for
    // nothing and gets nothing, said once here rather than by a predicate that
    // silently compiles away.
    if (source.kind === 'impossible') return []
    const sourceFilter = source.kind === 'filter' ? source.filter : {}

    if (params.zone === undefined) {
      const records = await this.store.query.query({
        collection: TRACKS_COLLECTION,
        filter: {
          where: { deviceId: params.deviceId },
          ...(Object.keys(timeBetween).length > 0 ? { whereBetween: timeBetween } : {}),
          ...stationaryExclusion,
          ...classFilter,
          ...sourceFilter,
          orderBy: { field: 'firstSeen', direction: 'desc' },
          limit,
        },
        ...projectionArg(params.projection),
      })
      return records.map((r) => this.rowToTrack(r.id, r.data, params.projection))
    }

    const zone = params.zone
    const bounds = zoneBounds(zone)
    // Envelope-overlap prefilter: envMinX ≤ zone.maxX AND envMaxX ≥ zone.minX
    // (same for Y), expressed as four inclusive BETWEEN ranges. Values are
    // normalized ~0..1; ±ENV_RANGE_SLACK keeps slightly-out-of-frame bboxes in.
    const overlapQuery = this.store.query.query({
      collection: TRACKS_COLLECTION,
      filter: {
        where: { deviceId: params.deviceId },
        ...stationaryExclusion,
        ...classFilter,
        ...sourceFilter,
        whereBetween: {
          ...timeBetween,
          envMinX: [-ENV_RANGE_SLACK, bounds.maxX],
          envMaxX: [bounds.minX, ENV_RANGE_SLACK],
          envMinY: [-ENV_RANGE_SLACK, bounds.maxY],
          envMaxY: [bounds.minY, ENV_RANGE_SLACK],
        },
        orderBy: { field: 'firstSeen', direction: 'desc' },
        limit,
      },
      // `needsPositions`: `rowMatchesZone` runs the precise per-position test on
      // the stored trajectory below, so this branch fetches `positions` even for
      // a slim caller. It still drops `snapshots`, and the TRACK it returns is
      // slim either way — `rowToTrack` omits `observations` on the projection,
      // not on whether a branch happened to have the blob in hand.
      ...projectionArg(params.projection, true),
    })
    // NULL-envelope complement: `BETWEEN` drops NULL rows and the query cap
    // has no IS NULL predicate, so re-fetch the device+time window and keep
    // only rows whose envelope is NULL (dims unknown at persist → always
    // match). The table is recreated with the new columns, so NULL rows are
    // rare (unknown-dims tracks only) and this stays cheap.
    const nullEnvQuery = this.store.query.query({
      collection: TRACKS_COLLECTION,
      filter: {
        where: { deviceId: params.deviceId },
        ...stationaryExclusion,
        // The zone path runs TWO queries — envelope-overlap and NULL-envelope —
        // and both need the class filter. Applying it to one would make the
        // chips work until the operator drew a zone, then quietly stop.
        ...classFilter,
        // …and the source filter, for a sharper version of the same reason: a
        // synthetic track has no positions, so it has no envelope, so it is
        // ALWAYS in this branch and always matches the zone. Omitting it here
        // would make drawing a zone the one gesture that puts every hidden
        // audio marker back on the timeline.
        ...sourceFilter,
        ...(Object.keys(timeBetween).length > 0 ? { whereBetween: timeBetween } : {}),
        orderBy: { field: 'firstSeen', direction: 'desc' },
        limit,
      },
      ...projectionArg(params.projection, true),
    })
    const [overlapRows, windowRows] = await Promise.all([overlapQuery, nullEnvQuery])
    const candidates = new Map<string, Record<string, unknown>>()
    for (const r of overlapRows) {
      if (typeof r.data['envMinX'] === 'number') candidates.set(r.id, r.data)
    }
    for (const r of windowRows) {
      if (r.data['envMinX'] === null || r.data['envMinX'] === undefined) {
        candidates.set(r.id, r.data)
      }
    }
    const matched: Array<{ id: string; data: Record<string, unknown> }> = []
    for (const [id, data] of candidates) {
      if (rowMatchesZone(data, zone)) matched.push({ id, data })
    }
    matched.sort((a, b) => Number(b.data['firstSeen'] ?? 0) - Number(a.data['firstSeen'] ?? 0))
    // The zone path is the ONLY read that ships `positions[]`, and its reader
    // — the client's `parsePositionBoxes` — keeps `p.bbox` and discards `x`,
    // `y`, `timestamp` and `source` on arrival. That was 59 % of the payload
    // spent to be thrown away, on the one query already measured as the heavy
    // one (7.9 MB for 380 rows, which missed its deadline and drew an empty
    // day). Narrowed here so the bytes are never sent (D471).
    return matched.slice(0, limit).map((r) => {
      const track = this.rowToTrack(r.id, r.data, params.projection)
      return { ...track, positions: geometryOnlyPositions(track.positions) }
    })
  }

  /**
   * Batched multi-device recent-tracks page (`listRecentTracks`): the
   * persisted completed tracks of every requested device, merged and ordered
   * by (`lastSeen` DESC, `trackId` DESC) with a stable opaque cursor.
   *
   * Approach — per-device indexed page + k-way merge (documented for the
   * cap): each device is fetched with ONE indexed query on
   * `idx_tracks_device_lastSeen` (`WHERE deviceId = ? AND lastSeen BETWEEN
   * ? AND ? ORDER BY lastSeen DESC LIMIT limit+1`), then the pages are
   * merged in memory and cut to `limit`. At events-page cardinalities
   * (≤ dozens of devices × ≤ 1000 rows) the in-memory merge is negligible
   * next to the row I/O, and every row fetched is a candidate (no scan
   * waste). The +1 overfetch makes `nextCursor` exact: when the merged
   * candidate set exceeds `limit` more rows are KNOWN to exist; when it
   * does not, every device returned fewer rows than asked for and is
   * therefore exhausted — so the final page always ends with
   * `nextCursor: null` (no empty trailing page).
   *
   * Cursor correctness: SQL can only bound `lastSeen`, and rows sharing the
   * cursor's exact millisecond have no defined SQL order — so a cursor page
   * runs TWO ranges per device: an exhaustive same-millisecond tie query
   * (`lastSeen = cursor.lastSeen`, id tie-break applied in memory) plus the
   * strictly-older indexed page (`lastSeen ≤ cursor.lastSeen - 1`). Tie
   * clusters are same-ms track expiries on one camera — physically tiny —
   * so the unbounded tie query stays O(1) in practice. Known accepted edge:
   * on a NON-cursor page, a same-ms tie cluster straddling a device's
   * `limit+1` SQL cut could omit a tie row (needs > limit rows sharing one
   * millisecond on one camera — unreachable at these cardinalities).
   *
   * Errors propagate (no partial merges): a failed device query fails the
   * page rather than silently returning an incomplete window.
   */
  /**
   * A page of RECENT track ids, and nothing else.
   *
   * Two callers only ever wanted the strings — `collectLiveTrackIds` (the
   * orphan audit's live set) and `listTrackIdPage` (the embedding rebuild's
   * cursor walk) — and both were reading whole tracks to build them. This reads
   * the primary key plus `lastSeen`, which is not a saving to be traded away:
   * the cursor, the descending order and the same-millisecond tie-break are all
   * defined on `lastSeen`, so a page without it would be unordered and
   * unresumable.
   *
   * It shares {@link recentPage} with {@link queryRecent} rather than repeating
   * the window/cursor arithmetic. Two copies of a paging rule is how one of
   * them learns about a new bound and the other does not.
   */
  async queryRecentIds(params: {
    deviceIds: readonly number[]
    since?: number
    until?: number
    limit?: number
    cursor?: string
    excludeStationaryPromotions?: boolean
    /** Track classes to keep. ABSENT or EMPTY means no filter — a superset
     *  prefilter on `classes[]`, exactly as `queryHistorical` does it. */
    classes?: readonly string[]
    /** Track SOURCES to leave out — see `ExcludeSourcesDoc` in the cap. ABSENT
     *  or EMPTY excludes nothing; compiled EXACTLY, never as a superset. */
    excludeSources?: readonly TrackSource[]
  }): Promise<{ trackIds: readonly string[]; nextCursor: string | null }> {
    const { page, nextCursor } = await this.recentPage(params, RECENT_IDS_COLUMNS)
    return { trackIds: page.map((r) => r.id), nextCursor }
  }

  async queryRecent(params: {
    deviceIds: readonly number[]
    since?: number
    until?: number
    limit?: number
    cursor?: string
    projection?: TrackProjection
    /** Exclude stationary-promoted rows (the events-feed contract). Default
     *  false: internal readers (retention, forensics) see every row. */
    excludeStationaryPromotions?: boolean
    /** Track classes to keep. ABSENT or EMPTY means no filter — a superset
     *  prefilter on `classes[]`, exactly as `queryHistorical` does it. */
    classes?: readonly string[]
    /** Track SOURCES to leave out — see `ExcludeSourcesDoc` in the cap. ABSENT
     *  or EMPTY excludes nothing; compiled EXACTLY, never as a superset. */
    excludeSources?: readonly TrackSource[]
  }): Promise<{ tracks: readonly Track[]; nextCursor: string | null }> {
    const { page, nextCursor } = await this.recentPage(params, trackColumnsFor(params.projection))
    const tracks = page.map((r) => this.rowToTrack(r.id, r.data, params.projection))
    return { tracks, nextCursor }
  }

  /**
   * The window, cursor and fan-out arithmetic behind every "recent tracks"
   * read — shared so the SELECT list is the only thing a caller varies.
   *
   * `columns` is passed straight through to the engine (`undefined` = the whole
   * row). Everything else here is projection-agnostic on purpose: which rows a
   * page contains, and in what order, must not depend on how much of each row
   * the caller asked to read.
   */
  private async recentPage(
    params: {
      deviceIds: readonly number[]
      since?: number
      until?: number
      limit?: number
      cursor?: string
      excludeStationaryPromotions?: boolean
      /** Track classes to keep. ABSENT or EMPTY means no filter — a superset
       *  prefilter on `classes[]`, exactly as `queryHistorical` does it. */
      classes?: readonly string[]
      /** Track SOURCES to leave out — see `ExcludeSourcesDoc` in the cap. ABSENT
       *  or EMPTY excludes nothing; compiled EXACTLY, never as a superset. */
      excludeSources?: readonly TrackSource[]
    },
    columns: readonly string[] | undefined,
  ): Promise<{
    page: ReadonlyArray<{ id: string; lastSeen: number; data: Record<string, unknown> }>
    nextCursor: string | null
  }> {
    const deviceIds = [...new Set(params.deviceIds)]
    if (deviceIds.length === 0) return { page: [], nextCursor: null }
    const source = trackSourceFilter(params.excludeSources)
    // Every known source excluded — nothing can match, and `nextCursor: null`
    // says so honestly instead of offering a page that will never arrive.
    if (source.kind === 'impossible') return { page: [], nextCursor: null }
    const sourceFilter = source.kind === 'filter' ? source.filter : {}
    const requested = Math.min(Math.max(params.limit ?? RECENT_DEFAULT_LIMIT, 1), RECENT_MAX_LIMIT)
    /**
     * The bound is on `deviceCount x limit`, because that — not `limit` — is
     * what the engine has to materialise (see {@link RECENT_FANOUT_ROW_BUDGET}).
     * Never below 1: a request naming more devices than the budget still has to
     * return something and offer a cursor.
     */
    const perDeviceBudget = Math.max(1, Math.floor(RECENT_FANOUT_ROW_BUDGET / deviceIds.length))
    const limit = Math.min(requested, perDeviceBudget)
    if (limit < requested) {
      // A page that is smaller than the caller asked for, with no line saying
      // so, reads as "there were no more tracks". It is not: `nextCursor` is
      // non-null and the client must follow it.
      this.logger.info('listRecentTracks page reduced by the fan-out budget', {
        meta: {
          requestedLimit: requested,
          servedLimit: limit,
          devices: deviceIds.length,
          budget: RECENT_FANOUT_ROW_BUDGET,
          remedy: 'follow nextCursor — no tracks are dropped',
        },
      })
    }
    const cursor = params.cursor !== undefined ? decodeRecentCursor(params.cursor) : null

    // Window on lastSeen. A cursor tightens the upper bound: every row after
    // the cursor position has lastSeen ≤ cursor.lastSeen.
    const lo = params.since ?? 0
    const winHi = params.until ?? Number.MAX_SAFE_INTEGER
    const hi = cursor !== null ? Math.min(cursor.lastSeen, winHi) : winHi
    if (hi < lo) return { page: [], nextCursor: null }

    // NULL-safe: normally-closed rows (and rows predating `closedReason`)
    // carry NULL and must survive the exclusion.
    const stationaryExclusion =
      params.excludeStationaryPromotions === true
        ? { whereNot: { closedReason: 'stationary-promotion' as const } }
        : {}
    // Same superset prefilter as the single-camera path — see
    // `queryHistorical`. The timeline's class chips must mean the same thing
    // whether one camera or twelve are in scope; they used to narrow a
    // downloaded page here while narrowing the READ there.
    const classFilter =
      params.classes !== undefined && params.classes.length > 0
        ? { whereJsonArrayAny: { classes: [...params.classes] } }
        : {}

    const fetchRange = async (
      deviceId: number,
      range: [number, number],
      pageLimit?: number,
    ): Promise<ReadonlyArray<{ id: string; data: Record<string, unknown> }>> =>
      this.store.query.query({
        collection: TRACKS_COLLECTION,
        filter: {
          where: { deviceId },
          ...stationaryExclusion,
          ...classFilter,
          ...sourceFilter,
          whereBetween: { lastSeen: range },
          orderBy: { field: 'lastSeen', direction: 'desc' },
          ...(pageLimit !== undefined ? { limit: pageLimit } : {}),
        },
        ...(columns === undefined ? {} : { columns }),
      })

    const perDevice = await Promise.all(
      deviceIds.map(async (deviceId) => {
        if (cursor === null || cursor.lastSeen > hi) {
          // No cursor (or the until bound already excludes the cursor ms):
          // one indexed page over the whole window.
          return fetchRange(deviceId, [lo, hi], limit + 1)
        }
        // Cursor page: exhaustive same-ms tie range (id tie-break in memory)
        // + the strictly-older indexed page.
        const tieRange: [number, number] = [cursor.lastSeen, cursor.lastSeen]
        const belowHi = cursor.lastSeen - 1
        const [ties, below] = await Promise.all([
          cursor.lastSeen >= lo ? fetchRange(deviceId, tieRange) : Promise.resolve([]),
          belowHi >= lo ? fetchRange(deviceId, [lo, belowHi], limit + 1) : Promise.resolve([]),
        ])
        return [...ties, ...below]
      }),
    )

    const candidates: Array<{
      id: string
      lastSeen: number
      data: Record<string, unknown>
    }> = []
    for (const rows of perDevice) {
      for (const r of rows) {
        const lastSeen = Number(r.data['lastSeen'] ?? 0)
        if (cursor !== null && !isAfterCursor({ lastSeen, id: r.id }, cursor)) continue
        candidates.push({ id: r.id, lastSeen, data: r.data })
      }
    }
    candidates.sort(compareRecentDesc)

    const page = candidates.slice(0, limit)
    const last = page[page.length - 1]
    const nextCursor =
      candidates.length > limit && last !== undefined
        ? encodeRecentCursor({ lastSeen: last.lastSeen, trackId: last.id })
        : null
    return { page, nextCursor }
  }

  /**
   * Deduplicated detector class names observed on a device's RECENT persisted
   * tracks (one indexed page, `lastSeen` desc). Feeds `listEventKinds` — a
   * representative "what has this camera actually seen" set, not an exhaustive
   * all-time DISTINCT (the query cap has none). Unions the primary `className`
   * with the accumulated `classes` array. Best-effort: [] on error.
   */
  async observedClassNames(deviceId: number, limit = 500): Promise<readonly string[]> {
    try {
      const rows = await this.store.query.query({
        collection: TRACKS_COLLECTION,
        filter: {
          where: { deviceId },
          orderBy: { field: 'lastSeen', direction: 'desc' },
          limit,
        },
      })
      const names = new Set<string>()
      for (const r of rows) {
        // Raw-row reader: this pages `data` directly for names only, bypassing
        // `rowToTrack` — so it must mirror the D189 rule itself. A legacy audio
        // row's className names what it HEARD (`speech`, `water`); offering
        // that here put the heard macro in the rule-editor class selector —
        // the vocabulary collision D189 removed.
        const isAudio = r.data['source'] === 'audio'
        const className = r.data['className']
        if (typeof className === 'string' && className.length > 0) {
          names.add(isAudio ? AUDIO_TRACK_CLASS : className)
        }
        const classes = r.data['classes']
        if (Array.isArray(classes)) {
          for (const c of classes) {
            if (typeof c === 'string' && c.length > 0) names.add(c)
          }
        }
      }
      return [...names]
    } catch (err) {
      this.logger.warn('TrackStore.observedClassNames failed', {
        meta: { deviceId, error: String(err) },
      })
      return []
    }
  }

  async getPersistedByTrackId(trackId: string): Promise<PersistedTrack | null> {
    const records = await this.store.query.query({
      collection: TRACKS_COLLECTION,
      filter: { where: { id: trackId }, limit: 1 },
    })
    if (records.length === 0) return null
    const row = records[0]!
    return this.rowToTrack(row.id, row.data)
  }

  /**
   * Batch read of persisted tracks. `listGroupRecords` cannot call
   * {@link getPersistedByTrackId} per member — that is one settings-store RPC
   * per row and a 60-group page takes ~20 s, which the viewer feed times out.
   */
  async getPersistedByTrackIds(trackIds: readonly string[]): Promise<readonly Track[]> {
    if (trackIds.length === 0) return []
    const PAGE = 500
    const out: Track[] = []
    for (let i = 0; i < trackIds.length; i += PAGE) {
      const chunk = trackIds.slice(i, i + PAGE)
      const rows = await this.store.query.query({
        collection: TRACKS_COLLECTION,
        filter: { whereIn: { id: [...chunk] }, limit: chunk.length },
      })
      for (const row of rows) out.push(this.rowToTrack(row.id, row.data))
    }
    return out
  }

  /**
   * Persist a SYNTHETIC track (a sensor/control event projected into the
   * unified track store). Unlike `persistCompleted` there is no live in-RAM
   * state and no trajectory envelope (synthetic tracks carry no positions) —
   * the row is written directly. `source: 'sensor'` marks it so spatial
   * consumers skip it; the existing time-based clustering joins it by
   * timestamp like any other track.
   */
  async persistSyntheticTrack(t: Track): Promise<void> {
    await this.store.set.mutate({
      collection: TRACKS_COLLECTION,
      key: t.trackId,
      value: {
        deviceId: t.deviceId,
        className: t.className,
        // All six tiered columns — a persist that carried only tier 1 would
        // silently drop the identity/species half on every expiry.
        ...(t.label !== undefined ? { label: t.label } : {}),
        ...(t.labelScore !== undefined ? { labelScore: t.labelScore } : {}),
        ...(t.labelMeta !== undefined ? { labelMeta: t.labelMeta } : {}),
        ...(t.subLabel !== undefined ? { subLabel: t.subLabel } : {}),
        ...(t.subLabelScore !== undefined ? { subLabelScore: t.subLabelScore } : {}),
        ...(t.subLabelMeta !== undefined ? { subLabelMeta: t.subLabelMeta } : {}),
        source: t.source ?? 'sensor',
        ...(t.producingDeviceName !== undefined
          ? { producingDeviceName: t.producingDeviceName }
          : {}),
        firstSeen: t.firstSeen,
        lastSeen: t.lastSeen,
        // Rounded and compressed (D471). `positions` was 94.9 % of this table
        // — 186.5 MB — and a third of each position was the float tail of a
        // PIXEL coordinate. Rounding is safe only since D399 gave a box its
        // `source`: the fractional part used to be what told a recovery box
        // from a full-frame one. `observations` below still counts the SAME
        // array, so the column cannot disagree with what it describes.
        positions: encodePositions(t.positions),
        // Written from the SAME array that becomes the blob, in the same
        // statement — the column cannot disagree with the trajectory it counts.
        observations: t.positions.length,
        snapshots: [...t.snapshots],
        zonesVisited: [...t.zonesVisited],
        ...(t.classes !== undefined ? { classes: [...t.classes] } : {}),
        // An audio marker carries the class it was heard as. Without this the
        // column stays NULL on synthetic rows and the marker is unlabelled —
        // the read path already handles it, only the write was missing.
        ...(t.audioLabels !== undefined && t.audioLabels.length > 0
          ? { audioLabels: [...t.audioLabels] }
          : {}),
        totalDistance: t.totalDistance,
        state: t.state,
      },
    })
  }

  private async persistCompleted(t: PersistedTrack): Promise<void> {
    // Normalized trajectory envelope for the zone-filtered query. Frame dims
    // come from the injected per-device provider (the runner's last inference
    // frame); when unknown the envelope + dims columns stay NULL and the row
    // always matches zone queries.
    // The frame the track was BORN on names the space its boxes live in; the
    // camera's latest analysis frame is the fallback for a track that carries
    // no provenance (D646).
    const dims =
      t.frameWidth !== undefined && t.frameHeight !== undefined
        ? { w: t.frameWidth, h: t.frameHeight }
        : this.frameDims?.(t.deviceId)
    const envelope = computeTrackEnvelope(t.positions, dims?.w, dims?.h)
    // `set` upserts — tolerates re-persists of the same trackId
    // (e.g. a track that expires twice because `expireStale` fires
    // before the previous call finishes clearing `this.active`).
    // `insert` would throw `UNIQUE constraint failed` on the second
    // attempt and leave the track un-persisted.
    await this.store.set.mutate({
      collection: TRACKS_COLLECTION,
      key: t.trackId,
      value: {
        deviceId: t.deviceId,
        className: t.className,
        // All six tiered columns — a persist that carried only tier 1 would
        // silently drop the identity/species half on every expiry.
        ...(t.label !== undefined ? { label: t.label } : {}),
        ...(t.labelScore !== undefined ? { labelScore: t.labelScore } : {}),
        ...(t.labelMeta !== undefined ? { labelMeta: t.labelMeta } : {}),
        ...(t.subLabel !== undefined ? { subLabel: t.subLabel } : {}),
        ...(t.subLabelScore !== undefined ? { subLabelScore: t.subLabelScore } : {}),
        ...(t.subLabelMeta !== undefined ? { subLabelMeta: t.subLabelMeta } : {}),
        ...(t.source !== undefined ? { source: t.source } : {}),
        firstSeen: t.firstSeen,
        lastSeen: t.lastSeen,
        // Rounded and compressed (D471). `positions` was 94.9 % of this table
        // — 186.5 MB — and a third of each position was the float tail of a
        // PIXEL coordinate. Rounding is safe only since D399 gave a box its
        // `source`: the fractional part used to be what told a recovery box
        // from a full-frame one. `observations` below still counts the SAME
        // array, so the column cannot disagree with what it describes.
        positions: encodePositions(t.positions),
        // Written from the SAME array that becomes the blob, in the same
        // statement — the column cannot disagree with the trajectory it counts.
        observations: t.positions.length,
        snapshots: [...t.snapshots],
        zonesVisited: [...t.zonesVisited],
        ...(t.classes !== undefined ? { classes: [...t.classes] } : {}),
        totalDistance: t.totalDistance,
        state: t.state,
        ...(t.importance !== undefined ? { importance: t.importance } : {}),
        ...(t.bestEventId !== undefined ? { bestEventId: t.bestEventId } : {}),
        ...(t.importanceReason !== undefined ? { importanceReason: t.importanceReason } : {}),
        ...(t.audioLabels !== undefined ? { audioLabels: [...t.audioLabels] } : {}),
        // Operator state survives the expiry-time persist. `set` REPLACES the
        // row, so omitting a status that was set on the live track would
        // silently erase an operator's mark at the moment the track completes —
        // and worse than losing a checkbox, the row would fall back to the
        // column default `'none'` and be swept on the very next pass.

        ...(t.retrainStatus !== undefined ? { retrainStatus: t.retrainStatus } : {}),
        ...(t.debug !== undefined ? { debug: t.debug } : {}),
        // Same `set`-REPLACES hazard: a note typed on a LIVE track lives only
        // in RAM until this write, and dropping it here would leave the flag
        // standing with the question that explains it gone.
        ...(t.debugNote !== undefined ? { debugNote: t.debugNote } : {}),
        ...(t.favourited !== undefined ? { favourited: t.favourited } : {}),
        ...(t.benchPinned !== undefined ? { benchPinned: t.benchPinned } : {}),
        // Same `set`-REPLACES hazard as the operator state above: a face seen on
        // the LIVE track exists only in RAM until this write, so omitting it
        // here would discard every in-session detection at the moment the track
        // completes — i.e. on exactly the rows the events page renders.
        ...(t.hasFace !== undefined ? { hasFace: t.hasFace } : {}),
        // Same hazard again: a gallery row that landed while the track was
        // still live exists only in RAM until this write.
        ...(t.hasEmbeddedFace !== undefined ? { hasEmbeddedFace: t.hasEmbeddedFace } : {}),
        // Same hazard again: a fold seen on the LIVE track lives only in RAM.
        ...(t.hasRider !== undefined ? { hasRider: t.hasRider } : {}),
        // `closeActive` (promotion) OR a short-motionless TTL expiry.
        ...(t.closedReason !== undefined ? { closedReason: t.closedReason } : {}),
        // The live track's own movement verdict (R2): a persisted source is
        // judged on it at a later promotion, never on the thinned trail.
        ...(t.moved !== undefined ? { moved: t.moved } : {}),
        ...(envelope !== null
          ? {
              envMinX: envelope.minX,
              envMinY: envelope.minY,
              envMaxX: envelope.maxX,
              envMaxY: envelope.maxY,
            }
          : {}),
        // The frame size is a fact of its own, not only the envelope's
        // denominator: written whenever it is known (D646).
        ...(dims !== undefined ? { frameWidth: dims.w, frameHeight: dims.h } : {}),
        ...(t.modelId !== undefined ? { modelId: t.modelId } : {}),
        ...(t.openedPlacement !== undefined ? { openedPlacement: t.openedPlacement } : {}),
        ...(t.closedPlacement !== undefined ? { closedPlacement: t.closedPlacement } : {}),
      },
    })
  }

  /**
   * Map a persisted row onto the cap `Track` shape. `projection: 'slim'`
   * drops the heavy `positions[]` / `snapshots[]` JSON (returned as empty
   * arrays — they are required on the schema) while keeping every scalar
   * the list surfaces render; `full` (default) is byte-compatible with the
   * pre-projection behaviour. The persisted envelope columns surface as the
   * optional `envelope` object in BOTH projections (four light numbers).
   */
  private rowToTrack(
    id: string,
    data: Record<string, unknown>,
    projection?: TrackProjection,
  ): PersistedTrack {
    const slim = projection === 'slim'
    // Under `slim` the SELECT does not fetch `positions` at all, so there is
    // nothing to read here — and reading `data['positions']` anyway would turn
    // "not fetched" into an empty trajectory, which is what the zone branch
    // would hand back after it HAD fetched the blob. One rule, both branches.
    // `decodePositions`, which reads every era: the compressed string this
    // store now writes, and the plain array every row written before D471
    // still holds. That is what makes a migration unnecessary — a row converts
    // itself the next time it is written, and never having been written is
    // fine. The cast this replaced would have handed a raw string downstream.
    const storedPositions = slim ? [] : decodePositions(data['positions'])
    /**
     * The stored count first, the blob only as a fallback — never `0` for a
     * column that was not read.
     *
     * `observations` used to be `positions.length` in both projections, and it
     * was honest only while slim meant "read the whole row, then decline to
     * RETURN the blob": the reader saved nothing. Now the slim SELECT omits
     * `positions`, so the same expression would report every track as having
     * zero sightings — a number, confidently wrong, on the one field whose
     * purpose is to answer `>= minHits` without pulling ~9 kB per row. Hence
     * the real column.
     *
     * A row written before that column exists carries NULL. A full read still
     * derives the count from the blob it fetched anyway; a slim read reports the
     * field ABSENT, which is the truth — it read neither source.
     */
    const storedObservations = data['observations']
    const observations =
      typeof storedObservations === 'number'
        ? storedObservations
        : slim
          ? undefined
          : storedPositions.length
    // Time order, not arrival order — see `positionsInTimeOrder` (D399). Rows
    // persisted before D399 are the ones that need it most: the blob they hold
    // was written in arrival order and cannot be rewritten.
    const positions = positionsInTimeOrder(storedPositions)
    const snapshots = slim ? [] : ((data['snapshots'] as TrackSnapshot[] | null) ?? [])
    const zones = (data['zonesVisited'] as string[] | null) ?? []
    const classes = data['classes'] as string[] | null
    const tiered = readTieredLabelColumns(data)
    const sourceParsed = TrackSourceSchema.safeParse(data['source'])
    const producingDeviceName = data['producingDeviceName']
    const importance = data['importance']
    const bestEventId = data['bestEventId']
    const importanceReason = data['importanceReason']
    const audioLabels = readAudioLabels(data['audioLabels'])
    // Operator state. `debug`: NULL / missing stays ABSENT (never coerced to
    // false), so "never touched" survives the round trip. The BOOLEAN column
    // type coerces 0/1 both directions, so a `typeof === 'boolean'` guard is
    // exact.
    //
    // `retrainStatus` is validated through the SCHEMA, not a value list — the
    // same lesson `source` above learned the hard way. An unparseable value
    // leaves BOTH the status and the derived `markForTrain` absent rather than
    // guessing a state; on a real row the NOT NULL default makes that
    // unreachable.
    const retrainParsed = RetrainStatusSchema.safeParse(data['retrainStatus'])
    const debug = data['debug']
    // Same read as `debug`: NULL / missing stays ABSENT. An EMPTY string is not
    // absent either — it is "marked, nothing to add", which is a different
    // answer from "this row predates the column".
    const debugNote = data['debugNote']
    const favourited = data['favourited']
    const benchPinned = data['benchPinned']
    // `hasFace`: same read as `debug` — NULL / missing stays ABSENT. A row from
    // before the column, or from a hub whose table never gained it, must not
    // read back as "no face"; the consumers' rule is `=== true`.
    const hasFace = data['hasFace']
    /** Same read as `hasFace` — NULL / missing stays ABSENT, never `false`.
     *  Here the distinction matters twice over: a row that predates the column
     *  must not read back as "this track had a face but nothing assignable came
     *  of it", which is exactly what `false` beside a true `hasFace` claims. */
    const hasEmbeddedFace = data['hasEmbeddedFace']
    /** Same read as `hasFace` — NULL / missing stays ABSENT, never `false`. */
    const hasRider = data['hasRider']
    /** Same read as `hasFace` — NULL / missing stays ABSENT, never `false`:
     *  an absent verdict must never dispose a source as "never moved" (R2). */
    const moved = data['moved']
    // Validated through the value list, not a bare string read: an unknown
    // reason from a newer writer reads as ABSENT (= "closed normally"), which
    // is the fail-open direction — it can only ever put a track BACK in a
    // consumer's view, never hide one.
    const closedReason = parseCloseReason(data['closedReason'])
    /** Free-form composed token line (see `composePreviewMissReason`) — a
     *  string read, absent stays absent. */
    const previewMissReason = data['previewMissReason']
    const modelId = data['modelId']
    // Through the SCHEMA, like `source`: a malformed or pre-column value reads
    // ABSENT, never a half-placement.
    const openedPlacement = TrackPlacementSchema.safeParse(data['openedPlacement'])
    const closedPlacement = TrackPlacementSchema.safeParse(data['closedPlacement'])
    const frameWidth = data['frameWidth']
    const frameHeight = data['frameHeight']
    const envMinX = data['envMinX']
    const envMinY = data['envMinY']
    const envMaxX = data['envMaxX']
    const envMaxY = data['envMaxY']
    const envelope =
      typeof envMinX === 'number' &&
      typeof envMinY === 'number' &&
      typeof envMaxX === 'number' &&
      typeof envMaxY === 'number'
        ? { minX: envMinX, minY: envMinY, maxX: envMaxX, maxY: envMaxY }
        : null
    // The ONE place a persisted row becomes a `Track` — so the D189 audio-class
    // contract is applied HERE and nowhere else. A legacy row (audio source,
    // naked heard macro as its class) reads back saying `audio`, with the macro
    // on `audioLabels` where a regular track already carries it. This compat is
    // deliberately TEMPORARY: `runAudioTrackClassMigration` converges the disk,
    // and once it reports 0 rewritten across a fleet boot this call is dead and
    // gets deleted (D182/D185 — no dual-read lives here forever).
    return normalizeAudioTrackClass({
      trackId: id,
      deviceId: Number(data['deviceId']),
      className: String(data['className']),
      ...tiered,
      // Validated through the SCHEMA, not a hand-written value list. The
      // hand-written pair silently dropped `source` on every row of any
      // source added afterwards — a synthetic audio marker would have read
      // back as a legacy pipeline track, straight past `isSpatialTrack`.
      ...(sourceParsed.success ? { source: sourceParsed.data } : {}),
      ...(typeof producingDeviceName === 'string' ? { producingDeviceName } : {}),
      firstSeen: Number(data['firstSeen']),
      lastSeen: Number(data['lastSeen']),
      positions,
      snapshots,
      zonesVisited: zones,
      ...(classes !== null ? { classes } : {}),
      totalDistance: Number(data['totalDistance'] ?? 0),
      state: (data['state'] as TrackState) ?? 'idle',
      active: false,
      ...(typeof importance === 'number' ? { importance } : {}),
      ...(typeof bestEventId === 'string' ? { bestEventId } : {}),
      ...(typeof importanceReason === 'string' ? { importanceReason } : {}),
      ...(Array.isArray(audioLabels) && audioLabels.length > 0 ? { audioLabels } : {}),
      ...(retrainParsed.success
        ? {
            retrainStatus: retrainParsed.data,
            markForTrain: retrainParsed.data === 'staging',
          }
        : {}),
      ...(typeof debug === 'boolean' ? { debug } : {}),
      ...(typeof debugNote === 'string' ? { debugNote } : {}),
      ...(typeof favourited === 'boolean' ? { favourited } : {}),
      ...(typeof benchPinned === 'boolean' ? { benchPinned } : {}),
      ...(typeof hasFace === 'boolean' ? { hasFace } : {}),
      ...(typeof hasEmbeddedFace === 'boolean' ? { hasEmbeddedFace } : {}),
      ...(typeof hasRider === 'boolean' ? { hasRider } : {}),
      ...(typeof moved === 'boolean' ? { moved } : {}),
      ...(closedReason !== undefined ? { closedReason } : {}),
      ...(typeof previewMissReason === 'string' && previewMissReason.length > 0
        ? { previewMissReason }
        : {}),
      // Spread, not assigned: an explicit `observations: undefined` key is
      // still a key, and `Object.hasOwn` — plus anything that serialises the
      // track — would report the field as present-and-empty rather than
      // not-read.
      ...(observations !== undefined ? { observations } : {}),
      ...(envelope !== null ? { envelope } : {}),
      ...(typeof modelId === 'string' && modelId.length > 0 ? { modelId } : {}),
      ...(typeof frameWidth === 'number' && typeof frameHeight === 'number'
        ? { frameWidth, frameHeight }
        : {}),
      ...(openedPlacement.success ? { openedPlacement: openedPlacement.data } : {}),
      ...(closedPlacement.success ? { closedPlacement: closedPlacement.data } : {}),
    })
  }
}
