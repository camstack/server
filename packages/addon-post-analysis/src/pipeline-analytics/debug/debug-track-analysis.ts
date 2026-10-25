/**
 * The FIRST analysis a debug-marked track gets — read entirely off the
 * inventory that already exists.
 *
 * The operator marks a track `debug` because something about it looked wrong.
 * This turns that hunch into a list of named, checkable statements: what the
 * track should have produced and did not. It is deliberately cheap — index rows
 * only, never a blob, never a decode, never a model — so the whole marked set
 * can be analysed in one request. Anything that needs pixels belongs in the
 * pipeline, not here.
 *
 * The finding codes and their thresholds are PORTED, not invented: they are the
 * set the `camstack-track-audit` runbook has been triaging live traffic with
 * (`ZERO_MEDIA`, `MISSING_FIRSTFRAME`, `LASTFRAME_STALE`, …). Re-deriving them
 * would have produced a second, differently-tuned vocabulary for the same
 * defects — and an operator comparing this tab against an audit run would have
 * had no way to tell a disagreement from a bug.
 *
 * ## What a finding is, and is not
 *
 * A finding is an OBSERVATION, never a verdict. `MISSING_LASTFRAME` on a track
 * that is still open is normal and is not reported; the same code on a closed
 * track is a real gap. Every rule that depends on the track being finished says
 * so, because a rule that fires on a live track trains the operator to ignore
 * the whole list.
 *
 * And per [D81](../../../../../docs/decisions/adr-0081.md), `debug` does NOT pin
 * retention: a marked track whose media was evicted shows as missing media and
 * is indistinguishable from one that never captured any. `MEDIA_EVICTED_OR_NEVER`
 * says exactly that rather than picking one of the two.
 */

import type { MediaFileKind, MediaFileRef } from '@camstack/types'
import type { MediaProvenance } from '../store/media-store.js'
import { RAW_CLASS_STEP_ID } from '../pipeline/label-utils.js'
import { linkedStepOf } from '@camstack/types'

/** A track is "short" below this — the pipeline rarely produces a full media set. */
export const SHORT_TRACK_MS = 2_000
/** Above this a track is long enough that periodic snapshots were expected. */
export const LONG_TRACK_MS = 10_000
/** A `lastFrame` older than this before the track's end is stale. */
const LASTFRAME_STALE_MS = 2_000
/** Media must cover at least this fraction of a long track's span. */
const MEDIA_COVERAGE_MIN = 0.5
/** Below this, the label the track settled on is weak enough to be worth saying. */
export const LOW_BEST_SCORE = 0.5

export type DebugFindingSeverity = 'error' | 'warn' | 'info'

export type DebugFindingCode =
  | 'MEDIA_EVICTED_OR_NEVER'
  | 'MISSING_KEYFRAME'
  | 'MISSING_FIRSTFRAME'
  | 'MISSING_LASTFRAME'
  | 'MISSING_THUMBNAIL'
  | 'MISSING_BEST_CROP'
  | 'MEDIA_ROW_WITHOUT_BLOB'
  | 'SHORT_TRACK'
  | 'ZERO_EVENTS'
  | 'ZERO_POSITIONS'
  | 'NO_PERIODIC_SNAPSHOTS'
  | 'LASTFRAME_STALE'
  | 'FIRSTFRAME_AFTER_LASTFRAME'
  | 'FIRSTFRAME_AFTER_TRACK_END'
  | 'MEDIA_STOPPED_EARLY'
  | 'NO_BEST_EVENT'
  | 'LOW_BEST_SCORE'
  | 'UNSCORED_LABEL'
  | 'BEST_SHOT_STANDIN'
  | 'BEST_SHOT_RASTER'

export interface DebugFinding {
  readonly code: DebugFindingCode
  readonly severity: DebugFindingSeverity
  /** One human sentence, carrying the number that triggered it. */
  readonly detail: string
}

/** The track fields the analysis reads. A projection, not the whole row. */
export interface DebugTrackFacts {
  readonly trackId: string
  readonly deviceId: number
  readonly className: string
  readonly label?: string
  readonly labelScore?: number
  /**
   * The step that WROTE the label (`labelMeta.stepId`). Read only to tell a
   * weak score from an absent one: {@link RAW_CLASS_STEP_ID} carries
   * `score: 0` by construction — the detector's own class inherits the
   * detection's standing instead of inventing a confidence — so a zero from
   * that step means "nothing scored this track", not "the classifier was
   * unsure". Absent on a row written before the column, which says nothing.
   */
  readonly labelStepId?: string
  readonly firstSeen: number
  readonly lastSeen: number
  /** True while the track is still being extended — most rules are held off. */
  readonly active: boolean
  readonly positionCount: number
  readonly snapshotCount: number
  readonly importance?: number
  readonly bestEventId?: string
  /**
   * The composed token line the close wrote when the track ended without a
   * NATIVE best-shot tile ([D276]). Absent on a track whose tile landed
   * native, on a row written before the column, and on a hub that predates the
   * field — all three mean "nothing to say", never "it went fine".
   */
  readonly previewMissReason?: string
  /**
   * A face DETECTOR produced a face detail on this track. **Absent ≠ false** —
   * a row written before the column omits it, so test `=== true`.
   *
   * Read only to SCOPE {@link DebugFindingCode} `MISSING_BEST_CROP`: it is the
   * evidence that a subject detail actually ran and something was therefore
   * owed a crop.
   */
  readonly hasFace?: boolean
  /** This track landed a gallery face row — a crop AND an embedding. Same
   *  absent-≠-false rule. With no `faceCrop` on the row this is a genuine
   *  contradiction, which is the case `MISSING_BEST_CROP` was meant to name. */
  readonly hasEmbeddedFace?: boolean
}

/** Everything one track's analysis needs, already gathered. Index rows only. */
export interface DebugTrackInventory {
  readonly facts: DebugTrackFacts
  /** Media across ALL owners of this track: `track:`, `face-`, `plate-`. */
  readonly media: readonly MediaFileRef[]
  readonly eventCount: number
  /**
   * Provenance of the track's stored `thumbnail` row, from the index alone.
   *
   * `null` = there is no thumbnail row at all (the `MISSING_THUMBNAIL` /
   * `MEDIA_EVICTED_OR_NEVER` case), `undefined` = the caller did not ask. A
   * pre-column row answers `native` by the D276 rank rule — an unclassifiable
   * tile is never reported as a stand-in, because "we cannot tell" must not
   * render as an accusation.
   */
  readonly thumbnailProvenance?: MediaProvenance | null
  /**
   * Ids (D482) of media rows whose BLOB could not be read, when the caller
   * probed.
   *
   * ABSENT means nobody asked — never "they all read", and never a fault. The
   * distinction is the whole point of the field: an index row and its bytes are
   * two different things, and until 2026-09-08 nothing here could tell them
   * apart. Five marked tracks reported six rows each and served 404 for every
   * one; `MediaStore.listByOwner` and `getById` both DROP a row whose read
   * throws, so a count taken from the index promised tiles the viewer could
   * never draw.
   */
  readonly unreadableMedia?: readonly number[]
}

/** Duration in ms. Never negative — a clock that went backwards reads as 0. */
export function trackDurationMs(facts: DebugTrackFacts): number {
  return Math.max(0, facts.lastSeen - facts.firstSeen)
}

function hasKind(media: readonly MediaFileRef[], kind: MediaFileKind): boolean {
  return media.some((m) => m.kind === kind)
}

/** Newest instant stamped on a row of `kind`, or `null` when the track owns
 *  none. Single-instance kinds hold at most one row; the max guards a legacy
 *  duplicate, mirroring `decideFirstLastFrameOrder`. */
function newestOfKind(media: readonly MediaFileRef[], kind: MediaFileKind): number | null {
  let newest: number | null = null
  for (const m of media) {
    if (m.kind !== kind) continue
    if (newest === null || m.timestamp > newest) newest = m.timestamp
  }
  return newest
}

function latestMediaAt(media: readonly MediaFileRef[]): number | null {
  let latest: number | null = null
  for (const m of media) if (latest === null || m.timestamp > latest) latest = m.timestamp
  return latest
}

function finding(
  code: DebugFindingCode,
  severity: DebugFindingSeverity,
  detail: string,
): DebugFinding {
  return { code, severity, detail }
}

/**
 * Analyse one track. Pure — same inventory in, same findings out.
 *
 * Order is stable and roughly "worst first": the media the whole rest of the
 * system reads, then the track's own substance, then the softer signals.
 */
export function analyseDebugTrack(inventory: DebugTrackInventory): readonly DebugFinding[] {
  const { facts, media, eventCount, thumbnailProvenance } = inventory
  const durationMs = trackDurationMs(facts)
  const closed = !facts.active
  const out: DebugFinding[] = []

  // Before the per-kind rules: a row that cannot be read is not a row the rest
  // of this function can reason about. Placed after nothing, because it is
  // about the media as a SET and does not exclude the kind rules — a track can
  // legitimately be missing its crop AND have unreadable rows.
  const unreadable = inventory.unreadableMedia ?? []
  if (unreadable.length > 0) {
    out.push(
      finding(
        'MEDIA_ROW_WITHOUT_BLOB',
        'error',
        `${unreadable.length} of ${media.length} media rows exist in the index but their ` +
          'bytes could not be read — the tile renders blank and every count taken from the ' +
          'index overstates what is there. The blob is missing, or its row names a storage ' +
          'location that no longer resolves.',
      ),
    )
  }

  if (media.length === 0) {
    // One code for both causes, because from here they are the same row: D81
    // does not pin retention for a debug mark, so an evicted track and a track
    // that captured nothing are byte-for-byte identical in the index.
    out.push(
      finding(
        'MEDIA_EVICTED_OR_NEVER',
        'error',
        'No media at all — either nothing was captured, or it was evicted (a debug mark does not pin retention).',
      ),
    )
  } else if (closed) {
    // Only meaningful once the track is finished: a live track legitimately has
    // no lastFrame yet, and reporting one would make the list noise.
    // The CASCADE, named once (D400). `keyFrame` missing ⇒ `keyFrameSmall`
    // missing ⇒ `decideLastFramePromotion` has no `copy` source ⇒ no
    // `lastFrame`. The operator's viewer renders per KIND, so before this one
    // capture failure read as two or three unrelated defects and was filed as
    // two separate complaints ("niente primo e ultimo", "niente ultimo" —
    // tracks 59bbae2b / a99af2f3, 2026-09-07). A finding still fires per kind
    // (the media really is absent), but it now carries its CAUSE.
    const keyFrameMissing = !hasKind(media, 'keyFrame')
    const lastFrameCopySourceMissing = keyFrameMissing || !hasKind(media, 'keyFrameSmall')
    const noSnapshot = !hasKind(media, 'snapshot')
    if (keyFrameMissing)
      out.push(finding('MISSING_KEYFRAME', 'error', 'No keyFrame — the best-shot frame is absent.'))
    if (!hasKind(media, 'firstFrame'))
      out.push(finding('MISSING_FIRSTFRAME', 'warn', 'No firstFrame for a closed track.'))
    if (!hasKind(media, 'lastFrame'))
      out.push(
        finding(
          'MISSING_LASTFRAME',
          'warn',
          noSnapshot && lastFrameCopySourceMissing
            ? `No lastFrame for a closed track — a CONSEQUENCE of ${
                keyFrameMissing ? 'the missing keyFrame' : 'the missing keyFrameSmall'
              }: with no snapshot to promote, the close can only copy keyFrameSmall, and there is none.`
            : 'No lastFrame for a closed track.',
        ),
      )
    if (!hasKind(media, 'thumbnail'))
      out.push(
        finding(
          'MISSING_THUMBNAIL',
          'warn',
          keyFrameMissing
            ? 'No thumbnail — every list surface renders blank; with no keyFrame the close-time derive had nothing to cut from.'
            : 'No thumbnail — every list surface renders blank.',
        ),
      )
    // MISSING_BEST_CROP, RE-SCOPED (D400). It used to fire on any closed track
    // owning no crop of any kind, which is the NORMAL shape: the detail plane
    // does not run on most tracks, so nothing was owed a crop. It reported on
    // 10 of the 14 tracks in the 2026-09-07 audit — including the two the audit
    // found fully healthy — and a finding that fires on healthy tracks means
    // nothing. It now fires only where a subject detail actually RAN and
    // nothing was cut for it: `hasEmbeddedFace` is stamped after the crop-store
    // insert, so it with no `faceCrop` is a straight contradiction, and
    // `hasFace` with no crop of any kind means the detail produced a face the
    // storage side dropped.
    const cropExpected = facts.hasFace === true || facts.hasEmbeddedFace === true
    const noCrop =
      !hasKind(media, 'crop') && !hasKind(media, 'faceCrop') && !hasKind(media, 'plateCrop')
    if (cropExpected && noCrop)
      out.push(
        finding(
          'MISSING_BEST_CROP',
          'warn',
          facts.hasEmbeddedFace === true
            ? 'A gallery face row was recorded for this track but no crop of any kind survives — the row promises an image the media index does not have.'
            : 'A face detail ran on this track but no crop of any kind was cut for it.',
        ),
      )
  }

  if (durationMs < SHORT_TRACK_MS)
    out.push(
      finding(
        'SHORT_TRACK',
        'warn',
        `Track lasted ${String(durationMs)} ms, under the ${String(SHORT_TRACK_MS)} ms floor — likely a fragment.`,
      ),
    )

  if (eventCount === 0)
    out.push(
      finding('ZERO_EVENTS', 'error', 'No object events — the track exists but recorded nothing.'),
    )

  if (facts.positionCount === 0)
    out.push(
      finding('ZERO_POSITIONS', 'error', 'No positions — there is no trajectory to reconstruct.'),
    )

  if (durationMs >= LONG_TRACK_MS && facts.snapshotCount === 0 && !hasKind(media, 'snapshot'))
    out.push(
      finding(
        'NO_PERIODIC_SNAPSHOTS',
        'warn',
        `No periodic snapshot over ${String(durationMs)} ms — the movement gate never opened.`,
      ),
    )

  if (closed && hasKind(media, 'lastFrame')) {
    const lastFrameAt = media
      .filter((m) => m.kind === 'lastFrame')
      .reduce((max, m) => Math.max(max, m.timestamp), 0)
    const lag = facts.lastSeen - lastFrameAt
    if (lag > LASTFRAME_STALE_MS)
      out.push(
        finding(
          'LASTFRAME_STALE',
          'warn',
          `lastFrame is ${String(lag)} ms older than the track's end.`,
        ),
      )
  }

  // "Ultimo frame prima del primo" [Last frame before the first] (device 3829, 2026-09-08 — `d035f251`,
  // `448678bb`, `7628b19d`). The operator filed this THREE times by hand,
  // because nothing here made the comparison: a track's "primo" tile stamped
  // later than its "ultimo" tile is a self-contradiction the index alone
  // answers, and it should never have needed an eye.
  //
  // Two SEPARATE codes because they have separate causes and separate fixes.
  // The media inversion is about which slot holds which bytes; the track-end
  // one is about a capture taken from a frame the subject was not in. A track
  // can have either alone (`7628b19d` had only the first).
  const firstFrameAt = newestOfKind(media, 'firstFrame')
  if (firstFrameAt !== null) {
    const lastFrameAt = newestOfKind(media, 'lastFrame')
    // Not gated on `closed`: a firstFrame newer than the lastFrame is wrong at
    // every moment of a track's life, so holding it back until close would only
    // delay the answer. Equality is NOT an inversion — a sub-interval track
    // legitimately collapses both slots onto one frame.
    if (lastFrameAt !== null && firstFrameAt > lastFrameAt)
      out.push(
        finding(
          'FIRSTFRAME_AFTER_LASTFRAME',
          'error',
          `firstFrame is ${String(firstFrameAt - lastFrameAt)} ms NEWER than lastFrame — the "primo" tile ` +
            'post-dates the "ultimo" one. The first view is captured at the CONFIRMED birth, which the ' +
            'confirmation gate can defer by up to its maxDeferralMs, while keyFrame/thumbnail/lastFrame ' +
            'are stamped at the earlier frame they were cut from.',
        ),
      )
    // This one IS closed-only: a live track's `lastSeen` is a moving target and
    // a media instant a few ms past it is the normal race, not a defect.
    if (closed && firstFrameAt > facts.lastSeen)
      out.push(
        finding(
          'FIRSTFRAME_AFTER_TRACK_END',
          'error',
          `firstFrame was captured ${String(firstFrameAt - facts.lastSeen)} ms AFTER the track's last ` +
            'observation — the tile shows a scene the subject had already left (a birth confirmed on a ' +
            'coasted frame).',
        ),
      )
  }

  if (closed && durationMs >= LONG_TRACK_MS && media.length > 0) {
    const latest = latestMediaAt(media)
    if (latest !== null) {
      const covered = (latest - facts.firstSeen) / durationMs
      if (covered < MEDIA_COVERAGE_MIN)
        out.push(
          finding(
            'MEDIA_STOPPED_EARLY',
            'warn',
            `Media stops at ${String(Math.round(covered * 100))}% of the track's span.`,
          ),
        )
    }
  }

  if (closed && facts.bestEventId === undefined)
    out.push(finding('NO_BEST_EVENT', 'info', 'No representative event was chosen for this track.'))

  // Two different defects, so two different codes. A raw-class label was never
  // scored by anything; saying it scored badly points the operator at a
  // classifier threshold that had no part in it.
  // A linked label (D715, `detector-link:<step>`) is the DETECTOR's answer for
  // that step: at score 0 it is the fallback nothing scored over; at a score it
  // is the detection's own confidence, not the classifier's.
  const linkedStep = linkedStepOf(facts.labelStepId)
  if (facts.labelStepId === RAW_CLASS_STEP_ID)
    out.push(
      finding(
        'UNSCORED_LABEL',
        'info',
        `The label is the detector's raw class (${facts.label ?? facts.className}) — no scored classifier answered for this track.`,
      ),
    )
  else if (linkedStep !== undefined && (facts.labelScore ?? 0) === 0)
    out.push(
      finding(
        'UNSCORED_LABEL',
        'info',
        `The label is the root detector's linked label for ${linkedStep} (${facts.label ?? facts.className}), held as a score-0 fallback — ${linkedStep} runs for this camera and no scored answer of it landed.`,
      ),
    )
  else if (
    linkedStep !== undefined &&
    facts.labelScore !== undefined &&
    facts.labelScore < LOW_BEST_SCORE
  )
    out.push(
      finding(
        'LOW_BEST_SCORE',
        'info',
        `The label came from the root detector standing in for ${linkedStep}; its score ${facts.labelScore.toFixed(2)} is the DETECTION's confidence, under ${String(LOW_BEST_SCORE)} — a ${linkedStep} threshold has no part in it.`,
      ),
    )
  else if (facts.labelScore !== undefined && facts.labelScore < LOW_BEST_SCORE)
    out.push(
      finding(
        'LOW_BEST_SCORE',
        'info',
        `Best label score ${facts.labelScore.toFixed(2)} is under ${String(LOW_BEST_SCORE)}.`,
      ),
    )

  // The operator's own report — "facce senza la persona" [faces without the person] — as a checkable
  // statement (D276). A tile that stood in for a subject is REPORTED, never
  // shown as if it were a best shot; `native` and a row too old to classify
  // both say nothing, which is the only honest answer for a tile whose origin
  // is not recorded.
  if (thumbnailProvenance === 'standin')
    out.push(
      finding(
        'BEST_SHOT_STANDIN',
        'warn',
        'Best shot is a stand-in: a face/plate detail crop copied in because no frame of the subject was captured.',
      ),
    )
  if (thumbnailProvenance === 'raster')
    out.push(
      finding(
        'BEST_SHOT_RASTER',
        'info',
        'Best shot is a sub-native raster crop of the subject, not a native capture.',
      ),
    )

  return out
}

/** One analysed track, as the UI and the bundle manifest both consume it. */
export interface DebugTrackReport {
  readonly trackId: string
  readonly deviceId: number
  readonly className: string
  readonly label?: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly durationMs: number
  readonly active: boolean
  readonly mediaCount: number
  readonly mediaKinds: readonly string[]
  readonly eventCount: number
  readonly positionCount: number
  readonly findings: readonly DebugFinding[]
  /** See {@link DebugTrackFacts.previewMissReason}. */
  readonly previewMissReason?: string
  /** See {@link DebugTrackInventory.thumbnailProvenance}. Omitted — never
   *  `null` — when the track has no thumbnail row, because "there is no tile"
   *  is already a finding and a second null field would say it twice. */
  readonly thumbnailProvenance?: MediaProvenance
}

/** Fold an inventory into the report shape, findings included. */
export function buildDebugTrackReport(inventory: DebugTrackInventory): DebugTrackReport {
  const { facts, media, eventCount, thumbnailProvenance } = inventory
  const kinds = [...new Set(media.map((m) => m.kind))].toSorted()
  return {
    trackId: facts.trackId,
    deviceId: facts.deviceId,
    className: facts.className,
    ...(facts.label === undefined ? {} : { label: facts.label }),
    firstSeen: facts.firstSeen,
    lastSeen: facts.lastSeen,
    durationMs: trackDurationMs(facts),
    active: facts.active,
    mediaCount: media.length,
    mediaKinds: kinds,
    eventCount,
    positionCount: facts.positionCount,
    findings: analyseDebugTrack(inventory),
    ...(facts.previewMissReason === undefined
      ? {}
      : { previewMissReason: facts.previewMissReason }),
    ...(thumbnailProvenance === undefined || thumbnailProvenance === null
      ? {}
      : { thumbnailProvenance }),
  }
}
