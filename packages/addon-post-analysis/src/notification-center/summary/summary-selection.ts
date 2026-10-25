/**
 * Which tracks become tiles — filter, rank, and the per-camera quota.
 *
 * Pure. No clock, no store, no I/O: a window's whole selection is a function of
 * the candidate list and the rule, which is what makes the quota provable
 * rather than plausible.
 *
 * ## The quota, and what it is protecting
 *
 * A multi-camera digest in which two of six cameras never appear is not a
 * multi-camera digest — it is a busy camera's digest with five names on it. The
 * driveway that sees forty passes a night would take every tile of a 3×3 grid
 * by pure ranking, every single night, and the operator would conclude the
 * other cameras were broken.
 *
 * So the first pass gives EVERY contributing camera its single best track,
 * cheapest-first in the rule's own rank order, and only the remaining slots go
 * to the global ranking. When there are more contributing cameras than tiles
 * the quota degrades honestly: the best cameras get their one tile, the rest
 * are counted as dropped and the count rides the log line — never silently.
 *
 * ## Only tracks the pipeline PROMOTED
 *
 * A digest is retrospective. The operator's own framing, verbatim: *"ideale
 * sarebbe considerare solo tracce che vengono alla fine promosse a tracce, dato
 * che il summary non è atteso di essere realtime"* [ideally we would consider only tracks that are eventually promoted to tracks, given that the summary is not expected to be realtime] — the window is closed
 * before this function is called, so the selection may wait for the pipeline's
 * verdict instead of guessing at it.
 *
 * The verdict is the tracker (v2, D683)'s own promotion threshold: a candidate is not
 * emitted as a track until it has been matched on `minHits` frames
 * (`isConfirmedForEmit`, per-device setting, *"minimum consecutive detection
 * hits before a track is promoted to output"*). The gate here re-applies that
 * same threshold to what the CLOSED row actually left behind — the count of
 * recorded sightings on its trajectory — and the port that builds a candidate
 * is the only thing that knows the device's `minHits`.
 *
 * This is not a movement heuristic and deliberately so: `totalDistance` and
 * `state` were both measured against live traffic and both hide real passages.
 * What they cannot see is the shape this gate is for — a row whose whole life
 * is one or two frames. Measured on device 102 (2026-08-19 04:12): two rows,
 * `closedReason` NULL so the parked pass is blind to them, dwell 53 ms,
 * `totalDistance` 0, two recorded sightings each. And `minImportance` cannot
 * cover it either, structurally: the static-track gate that demotes a frozen
 * subject needs two centroids to measure anything
 * (`computeStaticTrackMetrics`), so a single-sighting row is exactly the shape
 * it never scores down — 33 of the live hub's 34 such rows sit at or above 0.2.
 *
 * There is no rule field to turn it off. A digest of things that were never
 * tracks has no audience, and this repo has shipped knobs nobody read.
 *
 * ## Zones are scoped PER CAMERA
 *
 * `filters.zones` is a flat id list on a rule that spans cameras, and zone ids
 * are unique per camera. Evaluated flatly, picking a zone on camera A mutes
 * camera B forever: B's tracks can never visit A's polygon. `zone-ownership.ts`
 * is the one place that turns "the rule's ids" into "the ids that apply to THIS
 * camera", and it is reused here rather than re-derived — including its
 * fail-closed posture, where an ownership lookup that could not answer leaves
 * the flat behaviour untouched instead of widening the rule.
 */

import { type NcZoneOwnerLookup, scopeZoneIdsToDevice } from '../zone-ownership.js'
import type { NcSummaryFilters, NcSummaryRank } from './summary-rule.js'

/** One TRACK, reduced to what a selection decision actually reads. */
export interface SummaryCandidate {
  readonly trackId: string
  readonly deviceId: number
  readonly className: string
  readonly firstSeen: number
  readonly lastSeen: number
  /** The pipeline's own deterministic score. Absent on legacy rows ⇒ 0. */
  readonly importance?: number
  /** Zone IDS the track visited (`Track.zonesVisited`). */
  readonly zones: readonly string[]
  /** Every class observed over the track's life, when the row carries them. */
  readonly classes?: readonly string[]
  /**
   * The track was closed by STATIONARY PROMOTION — the tracker decided the
   * subject had parked (`TrackStore.closedReason`). Not a passage.
   *
   * Absent means "closed normally, or the row predates the marker" — never
   * read an absence as a positive. The consequence is deliberate and
   * fail-open: a digest produced against an old row shows the parked car once
   * more rather than hiding a passage it could not classify.
   */
  readonly stationary?: boolean
  /**
   * The pipeline PROMOTED this row to a track: its persisted trajectory holds
   * at least `minHits` recorded sightings — the same count the tracker
   * (v2, D683) requires before it emits a candidate at all. See the module
   * header.
   *
   * Absent means "the caller could not answer", never "no". Fail-open, in the
   * direction that cannot destroy work: keeping a phantom one more night is
   * recoverable, and hiding a passage is the failure this repo has paid for
   * twice. The production port always answers, so an absence is a defect —
   * which is why it is COUNTED ({@link SummaryFilterReport.unknownConfirmation})
   * instead of silently folded into the kept set.
   */
  readonly confirmed?: boolean
}

/** Why a candidate did not make it — counted, so a thin digest is explainable. */
export interface SummaryFilterReport {
  readonly kept: readonly SummaryCandidate[]
  readonly droppedByClass: number
  readonly droppedByZone: number
  readonly droppedByImportance: number
  readonly droppedByDwell: number
  /** Parked objects dropped because the rule asks for passages (the default). */
  readonly droppedStationary: number
  /** Rows the pipeline never promoted to a track. Always on, no rule field. */
  readonly droppedUnconfirmed: number
  /**
   * Candidates that carried no promotion signal at all and were therefore
   * KEPT. Non-zero on a live hub means the port stopped answering and the gate
   * is inert — a number nobody prints is how a gate dies unnoticed.
   */
  readonly unknownConfirmation: number
}

function classesOf(candidate: SummaryCandidate): readonly string[] {
  const extra = candidate.classes ?? []
  return extra.includes(candidate.className) ? extra : [candidate.className, ...extra]
}

function dwellSeconds(candidate: SummaryCandidate): number {
  return Math.max(0, candidate.lastSeen - candidate.firstSeen) / 1000
}

/**
 * Apply the rule's filters. Counting every drop reason is not decoration: the
 * question an operator asks about a digest is always "why is it empty", and a
 * branch that discards work silently reads as "it never happened".
 */
export function filterSummaryCandidates(
  candidates: readonly SummaryCandidate[],
  filters: NcSummaryFilters | undefined,
  zoneOwner?: NcZoneOwnerLookup,
): SummaryFilterReport {
  // The PROMOTION pass runs before everything, including the parked pass and
  // including a rule that declares no filters at all: "is this a track" is a
  // question that precedes "is it the kind of track the rule wants", and a row
  // that is both a phantom and parked must be counted once, under the first
  // reason that answered. It has to run ahead of `selectSummaryTiles` for a
  // second, load-bearing reason — the per-camera quota hands EVERY contributing
  // camera its single best track, so a camera whose only candidate is a phantom
  // would be given a tile for it.
  const promoted = candidates.filter((candidate) => candidate.confirmed !== false)
  const droppedUnconfirmed = candidates.length - promoted.length
  const unknownConfirmation = promoted.filter(
    (candidate) => candidate.confirmed === undefined,
  ).length

  // The PARKED pass runs next, and it too runs even when the rule declares no
  // filters at all. "No filters" means "no class, zone or score condition" — it
  // has never meant "put the car park in the digest", and a rule authored
  // before this option existed carries `filters: undefined`, which is exactly
  // the rule the operator is looking at. Since D161 a promoted track is
  // persisted instead of forgotten, so every parked object in the window now
  // reaches this function; the measured digest went from 1-2 tiles to 10.
  const includeStationary = filters?.includeStationary === true
  const moving = includeStationary
    ? promoted
    : promoted.filter((candidate) => candidate.stationary !== true)
  const droppedStationary = promoted.length - moving.length

  if (filters === undefined) {
    return {
      kept: [...moving],
      droppedByClass: 0,
      droppedByZone: 0,
      droppedByImportance: 0,
      droppedByDwell: 0,
      droppedStationary,
      droppedUnconfirmed,
      unknownConfirmation,
    }
  }
  const include = filters.classes
  const exclude = new Set(filters.classesExclude ?? [])
  const kept: SummaryCandidate[] = []
  let droppedByClass = 0
  let droppedByZone = 0
  let droppedByImportance = 0
  let droppedByDwell = 0

  for (const candidate of moving) {
    const own = classesOf(candidate)
    if (own.some((c) => exclude.has(c))) {
      droppedByClass += 1
      continue
    }
    if (include !== undefined && include.length > 0 && !own.some((c) => include.includes(c))) {
      droppedByClass += 1
      continue
    }
    const wantedZones = filters.zones
    if (wantedZones !== undefined && wantedZones.length > 0) {
      const scope = scopeZoneIdsToDevice(wantedZones, candidate.deviceId, zoneOwner)
      // `inert` = this camera owns NONE of the rule's zones, so the condition
      // does not apply to it and the track matches whole-frame. `unchanged`
      // includes the "ownership unknown" answer, which deliberately keeps the
      // flat behaviour rather than widening the rule (D49's asymmetry).
      if (scope.kind !== 'inert') {
        const ids = scope.kind === 'scoped' ? scope.ids : wantedZones
        if (!candidate.zones.some((z) => ids.includes(z))) {
          droppedByZone += 1
          continue
        }
      }
    }
    if (
      filters.minImportance !== undefined &&
      (candidate.importance ?? 0) < filters.minImportance
    ) {
      droppedByImportance += 1
      continue
    }
    if (
      filters.minDwellSeconds !== undefined &&
      dwellSeconds(candidate) < filters.minDwellSeconds
    ) {
      droppedByDwell += 1
      continue
    }
    kept.push(candidate)
  }
  return {
    kept,
    droppedByClass,
    droppedByZone,
    droppedByImportance,
    droppedByDwell,
    droppedStationary,
    droppedUnconfirmed,
    unknownConfirmation,
  }
}

/**
 * The rank value, higher is better. Ties break on `trackId` so a selection is
 * REPRODUCIBLE — two runs over the same window must produce the same mosaic,
 * or a retry after a failed publish silently changes what was delivered.
 */
function rankValue(candidate: SummaryCandidate, rank: NcSummaryRank): number {
  switch (rank) {
    case 'importance':
      return candidate.importance ?? 0
    case 'recency':
      return candidate.lastSeen
    case 'dwell':
      return candidate.lastSeen - candidate.firstSeen
  }
}

function byRankDesc(rank: NcSummaryRank) {
  return (a: SummaryCandidate, b: SummaryCandidate): number => {
    const delta = rankValue(b, rank) - rankValue(a, rank)
    return delta !== 0 ? delta : a.trackId.localeCompare(b.trackId)
  }
}

export interface SummarySelection {
  /** The chosen tracks, in CHRONOLOGICAL order — a mosaic reads left-to-right
   *  as a timeline, and tile `i` is a stable index the artefact can reference. */
  readonly tiles: readonly SummaryCandidate[]
  /** Cameras that contributed at least one candidate. */
  readonly camerasContributing: number
  /** Cameras that contributed a candidate and got NO tile (quota exhausted). */
  readonly camerasDropped: number
  /** Candidates that matched the filters but did not fit the budget. */
  readonly overflow: number
}

/**
 * Choose the tiles: one guaranteed slot per contributing camera first, then the
 * global ranking for what remains.
 */
export function selectSummaryTiles(
  candidates: readonly SummaryCandidate[],
  opts: { readonly maxTiles: number; readonly rank: NcSummaryRank },
): SummarySelection {
  const sorted = candidates.toSorted(byRankDesc(opts.rank))
  const byDevice = new Map<number, SummaryCandidate[]>()
  for (const candidate of sorted) {
    const bucket = byDevice.get(candidate.deviceId)
    if (bucket === undefined) byDevice.set(candidate.deviceId, [candidate])
    else bucket.push(candidate)
  }

  // Quota pass — each camera's OWN best, offered in the order their bests rank.
  // `sorted` is already in that order, so the first time a device is met is its
  // best track; that keeps the quota deterministic without a second sort.
  const chosen: SummaryCandidate[] = []
  const taken = new Set<string>()
  const servedDevices = new Set<number>()
  for (const candidate of sorted) {
    if (chosen.length >= opts.maxTiles) break
    if (servedDevices.has(candidate.deviceId)) continue
    servedDevices.add(candidate.deviceId)
    taken.add(candidate.trackId)
    chosen.push(candidate)
  }

  // Fill pass — pure ranking over everything the quota did not already take.
  for (const candidate of sorted) {
    if (chosen.length >= opts.maxTiles) break
    if (taken.has(candidate.trackId)) continue
    taken.add(candidate.trackId)
    chosen.push(candidate)
  }

  const tiles = chosen.toSorted((a, b) =>
    a.firstSeen !== b.firstSeen ? a.firstSeen - b.firstSeen : a.trackId.localeCompare(b.trackId),
  )
  return {
    tiles,
    camerasContributing: byDevice.size,
    camerasDropped: byDevice.size - servedDevices.size,
    overflow: Math.max(0, candidates.length - tiles.length),
  }
}

/**
 * Ranked leftover after the quota pass — refill a mosaic that dropped
 * duplicate frames or missing crops without walking the same track twice.
 */
export function remainingSummaryCandidates(
  kept: readonly SummaryCandidate[],
  taken: readonly SummaryCandidate[],
  rank: NcSummaryRank,
): readonly SummaryCandidate[] {
  const takenIds = new Set(taken.map((c) => c.trackId))
  return kept.filter((c) => !takenIds.has(c.trackId)).toSorted(byRankDesc(rank))
}

/**
 * The media a tile is drawn from, best first.
 *
 * A digest tile is a SUBJECT, so the crops come first: the TRACK's own subject
 * crop (`thumbnail`, then its `thumbnailSmall` downscale), and only then the
 * clean whole scene (`keyFrame` → `keyFrameSmall` → `fullFrame`).
 *
 * ⚠ The whole-scene rungs are a FALLBACK and stay on the ladder. Measured on
 * 60 real tracks (101/102, 24 h): 52 carry a crop, 43 carry a scene rung, and
 * 2 carry a scene rung and NO crop — dropping the fallback would delete those
 * two tiles for nothing. A track with neither is dropped, never drawn as an
 * empty cell (see `NcSummaryProducer.loadTiles`).
 *
 * ## Why `thumbnail` is on the ladder (2026-08-27)
 *
 * It was removed on 2026-08-24 (160200681) because a successful plate read
 * overwrites the vehicle first-level crop under the same `thumbnail` kind.
 * **That collision belonged to the GROUP entity** — its sealer was what wrote
 * `ownerKind: 'group', kind: 'thumbnail'`. On a TRACK, plates live under
 * `ownerKind: 'plate'` / `kind: 'plateCrop'` and never touch `thumbnail`. The
 * same commit turned the group process off, so the two group-only head rungs
 * became unreachable and every digest tile fell through to `keyFrame` — a
 * whole frame — for three days. The group entity was deleted outright on
 * 2026-09-01 and its rungs went with it;
 * `scripts/check-summary-ladder-reachable.ts` is the guard that keeps the
 * best reachable rung a subject crop.
 *
 * Boxed frames stay absent: a drawn rectangle is a permanent lie in a digest
 * tile. Plate and face crops stay absent: a digest tile of a targa is the
 * wrong picture. Duplicate driveways from tracker ID churn are collapsed by
 * `frameDedupeKey`, not by hiding the whole-scene fallback.
 */
export const SUMMARY_MEDIA_LADDER = [
  'thumbnail',
  'thumbnailSmall',
  'keyFrame',
  'keyFrameSmall',
  'fullFrame',
] as const

export type SummaryMediaKind = (typeof SUMMARY_MEDIA_LADDER)[number]

/**
 * Rungs that are a picture OF THE SUBJECT rather than of the whole scene.
 *
 * The invariant the guard enforces: the FIRST rung of the ladder must be one
 * of these. A ladder whose head is a whole frame delivers whole frames — which
 * is exactly what shipped for three days on 2026-08-24 when the two head rungs
 * were group-only and the group process was off (D247).
 */
export const SUMMARY_SUBJECT_CROP_RUNGS: ReadonlySet<SummaryMediaKind> = new Set([
  'thumbnail',
  'thumbnailSmall',
])

/**
 * Is this rung a picture OF THE SUBJECT, from a row whose `kind` is a plain
 * string?
 *
 * A stored row's kind is untyped by the time it reaches here, and widening it
 * with a cast would let any future kind through unnoticed. This asks the set
 * the honest way round.
 */
export function isSubjectCropRung(kind: string): boolean {
  for (const rung of SUMMARY_SUBJECT_CROP_RUNGS) if (rung === kind) return true
  return false
}

/**
 * The floor below which a `thumbnail` row is NOT a subject crop.
 *
 * `copyFaceCropIfTrackHasNoThumbnail` (`pipeline-analytics/copy-face-crop-preview.ts`)
 * copies the persisted face crop onto a track that has no preview of its own,
 * and it stores it under `kind: 'thumbnail'` — so an ArcFace **112×112**
 * alignment template lands on the ladder wearing the same kind as a real
 * subject crop. Measured: 3 of 52 track thumbnails (5.8%) are 3–10 KB
 * templates. Delivering one is a face in a digest of passages.
 *
 * 20 KiB is chosen as the smallest number that is unambiguous in BOTH
 * directions: it is 2× the largest template observed (10 KB) and above the
 * theoretical ceiling of a 112×112 JPEG at any quality, while a native-
 * resolution subject crop measures in the hundreds of KB. The second reason
 * the number is safe: a genuine crop small enough to fall under it is a
 * subject a few dozen pixels across, which is a smear in a mosaic cell — the
 * whole-scene rung below is the better picture either way.
 *
 * The check costs NOTHING: `MediaFileInfo.sizeBytes` is already on the index
 * row, so no blob is fetched and nothing is decoded to apply it.
 */
export const SUMMARY_THUMBNAIL_MIN_BYTES = 20_480

/** The rungs {@link SUMMARY_THUMBNAIL_MIN_BYTES} is applied to. */
const SUMMARY_SIZE_GATED_RUNGS: ReadonlySet<SummaryMediaKind> = new Set(['thumbnail'])

/**
 * One media index row, as the ladder needs to see it (never the bytes).
 *
 * `sizeBytes` is `null` — never absent — when the row has no index entry to
 * read a size from. `null` means "unknown", and unknown never drops a row;
 * only a size the index actually reported can.
 */
export interface SummaryMediaRow {
  /** The media row's own id (D482) — the address, never a composite key. */
  readonly mediaId: number
  readonly kind: string
  readonly timestamp: number
  readonly sizeBytes: number | null
}

/**
 * Is this row a picture, or a template wearing a picture's kind?
 *
 * Only a size the index REPORTED can demote a row. A `null` size is unknown,
 * and demoting on unknown would silently delete every row an index could not
 * measure.
 */
function rowClearsSizeFloor(row: SummaryMediaRow, rung: SummaryMediaKind): boolean {
  if (!SUMMARY_SIZE_GATED_RUNGS.has(rung)) return true
  // `typeof`, not `=== null`: the field is required by the type, so the only
  // way a row reaches here without a number is a caller that predates it. That
  // is "unknown", and unknown must behave exactly like `null` — the alternative
  // is a floor that silently deletes every row an older caller produces.
  if (typeof row.sizeBytes !== 'number') return true
  return row.sizeBytes >= SUMMARY_THUMBNAIL_MIN_BYTES
}

/**
 * Pick ONE media row for a track — the cheap question first (index rows only),
 * so exactly one blob is ever read.
 *
 * Within a rung the row CLOSEST to the track's peak is chosen; a member may
 * carry more than one full-frame still, so "the first one" would systematically
 * pick the moment the subject entered rather than the moment it was best seen.
 *
 * A `thumbnail` under {@link SUMMARY_THUMBNAIL_MIN_BYTES} DESCENDS to the next
 * rung rather than being drawn — see that constant for the face template it
 * exists to catch.
 */
export function pickSummaryMedia(
  rows: readonly SummaryMediaRow[],
  aroundMs: number,
): SummaryMediaRow | null {
  for (const rung of SUMMARY_MEDIA_LADDER) {
    const matches = rows.filter((row) => row.kind === rung && rowClearsSizeFloor(row, rung))
    if (matches.length === 0) continue
    return matches.reduce((best, row) =>
      Math.abs(row.timestamp - aroundMs) < Math.abs(best.timestamp - aroundMs) ? row : best,
    )
  }
  return null
}

/**
 * Same camera, same wall-clock second → same JPEG. Tracker ID churn
 * otherwise fills a mosaic with eleven copies of one driveway still.
 */
export function frameDedupeKey(deviceId: number, mediaTimestamp: number): string {
  return `${deviceId}:${Math.floor(mediaTimestamp / 1000)}`
}
