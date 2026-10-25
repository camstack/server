/**
 * key-event-query — rank completed tracks into importance-ordered key events.
 *
 * Pure over its inputs (a candidate track list + a peak-lookup for legacy rows):
 * tracks already carrying a persisted `importance` are used as-is; rows written
 * before scoring shipped are scored ON READ via `peakLookup` WITHOUT persisting
 * (forward-only migration). Filters by class + minImportance, orders by
 * importance desc, and trims to `limit`.
 */

import type { KeyEvent, Track } from '@camstack/types'
import type { ImportancePeak } from './key-event-recompute.js'
import { computeImportance } from './key-event-scoring.js'
import { displayLabel } from './label-tier.js'
import { averageBboxDiagonal, computeStaticTrackMetrics } from './static-track-gate.js'

export interface KeyEventQueryOptions {
  readonly limit: number
  readonly minImportance?: number
  readonly classFilter?: string
}

/** Resolve a track's peak (confidence / bbox / best-event id) for on-read scoring. */
export type PeakLookup = (trackId: string) => Promise<ImportancePeak>

export async function rankKeyEvents(
  candidates: readonly Track[],
  options: KeyEventQueryOptions,
  peakLookup: PeakLookup,
): Promise<readonly KeyEvent[]> {
  const scored: KeyEvent[] = []
  for (const t of candidates) {
    // Synthetic sensor/control tracks (`source:'sensor'`, e.g. a switch toggle
    // or contact/lock state change) STAY VISIBLE in the gallery/key-event/
    // timeline surface (operator decision — reverting the earlier #23-B
    // exclusion): they are legitimate event markers and carry a full-frame
    // snapshot of the whole scene (they have no bbox). Privacy is handled at
    // CAPTURE time instead — the synthetic snapshot is downscaled to ~640×360
    // before it is ever persisted (see `synthetic-sensor-track.ts`), so no raw
    // native-resolution (e.g. 4K bedroom) frame is ever stored or served.
    if (options.classFilter !== undefined && t.className !== options.classFilter) continue
    let importance = t.importance
    let bestEventId = t.bestEventId
    if (importance === undefined) {
      const peak = await peakLookup(t.trackId)
      // On-read scoring of a legacy row has no frame geometry, so normalize the
      // static-object gate to the track's average bbox diagonal (the documented
      // fallback). A genuinely frozen object still reads ~0 displacement and is
      // demoted; identified tracks are never suppressed (inside computeImportance).
      const staticMetrics = computeStaticTrackMetrics(
        t.positions.map((p) => ({ x: p.x, y: p.y })),
        averageBboxDiagonal(t.positions.map((p) => p.bbox)),
      )
      importance = computeImportance({
        peakConfidence: peak.peakConfidence,
        className: t.className,
        durationMs: t.lastSeen - t.firstSeen,
        peakBboxAreaFrac: peak.peakBboxAreaFrac,
        totalDistance: t.totalDistance,
        zonesVisited: t.zonesVisited,
        // The two tiers travel SEPARATELY (2026-08-20): `label` is the display
        // caption (identity WEIGHT), `identityLabel` is tier 2 only and is what
        // the static gate reads. An earlier comment here said the scorer "wants
        // the finest thing known, not one tier of it" — true of the caption,
        // false of the gate, and the conflation cost 68 tracks/day their demotion.
        ...(displayLabel(t) !== undefined ? { label: displayLabel(t) } : {}),
        ...(t.subLabel !== undefined ? { identityLabel: t.subLabel } : {}),
        ...(staticMetrics
          ? {
              netDisplacementFrac: staticMetrics.netDisplacementFrac,
              pathSpanFrac: staticMetrics.pathSpanFrac,
            }
          : {}),
      }).importance
      bestEventId = bestEventId ?? peak.bestEventId
    }
    if (options.minImportance !== undefined && importance < options.minImportance) continue
    scored.push({
      id: bestEventId ?? t.trackId,
      trackId: t.trackId,
      timestamp: t.firstSeen,
      className: t.className,
      // BOTH tiers ride the row: the events grid renders `subLabel ?? label`
      // and cannot evaluate it from half of one.
      ...(t.label !== undefined ? { label: t.label } : {}),
      ...(t.labelScore !== undefined ? { labelScore: t.labelScore } : {}),
      ...(t.labelMeta !== undefined ? { labelMeta: t.labelMeta } : {}),
      ...(t.subLabel !== undefined ? { subLabel: t.subLabel } : {}),
      ...(t.subLabelScore !== undefined ? { subLabelScore: t.subLabelScore } : {}),
      ...(t.subLabelMeta !== undefined ? { subLabelMeta: t.subLabelMeta } : {}),
      importance,
      // Fall back to the trackId (never an empty string) so the media plane
      // always has a resolvable key: a track whose only object event is a
      // degenerate `state:'left'` departure (zero-area bbox, no crop) yields
      // no `bestEventId` from `peakForTrack`, but its §5-cadence track
      // `thumbnail`/`lastFrame`/`firstFrame` media still exists. The
      // event-media resolver falls back to track-owned media for a trackId,
      // so the card renders the real track frame instead of a blank tile.
      bestEventId: bestEventId ?? t.trackId,
      windowMs: t.lastSeen - t.firstSeen,
      // Operator state rides the row so the grid can render its toggles from
      // the feed. Absent stays ABSENT — a `?? false` here would make every
      // never-touched track indistinguishable from a deliberately cleared one.
      // `retrainStatus` comes along because the boolean cannot express the third
      // state: a trained track reports `markForTrain: false` exactly like a
      // never-marked one, and the grid's badge is the difference.
      ...(t.markForTrain !== undefined ? { markForTrain: t.markForTrain } : {}),
      ...(t.retrainStatus !== undefined ? { retrainStatus: t.retrainStatus } : {}),
      ...(t.debug !== undefined ? { debug: t.debug } : {}),
      ...(t.favourited !== undefined ? { favourited: t.favourited } : {}),
      // D189: the heard audio macros live on `audioLabels`, not in `className`
      // (`audio` is the taxonomy). Absent stays absent — a row with no
      // confident episodes must not invent an empty array the card would
      // treat as "heard nothing interesting".
      ...(t.audioLabels !== undefined && t.audioLabels.length > 0
        ? { audioLabels: t.audioLabels }
        : {}),
    })
  }
  scored.sort((a, b) => b.importance - a.importance)
  return scored.slice(0, options.limit)
}
