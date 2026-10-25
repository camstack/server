/**
 * Truth × replay → one TrackEval sequence (spec §5.4).
 *
 * A bound output is matched to ITS detection's truth box with similarity 1
 * (IoU against the others), so the bench measures association and which
 * detections are kept. Coasting outputs are predictions and are excluded.
 * Outputs on ignore regions are removed first — TrackEval's MOT preprocessing,
 * done here so the metric code stays TrackEval's. A second box of one identity
 * in one frame (two live tracks the operator called one subject, concurrently)
 * is a duplicate detection and becomes ignore; likewise a second output of one
 * final id.
 */
import type { Truth } from '../ground-truth.js'
import type { ReplayResult } from '../replay.js'
import type { TapeBox } from '../tape-schema.js'
import type { TapeTrackOutput } from '../trackers/tape-tracker.js'
import type { MetricFrame, MetricSequence } from './metric-sequence.js'

const IGNORE_IOU = 0.5

export function iou(a: TapeBox, b: TapeBox): number {
  const x1 = Math.max(a[0], b[0])
  const y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[0] + a[2], b[0] + b[2])
  const y2 = Math.min(a[1] + a[3], b[1] + b[3])
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a[2] * a[3] + b[2] * b[3] - inter
  return union <= 0 ? 0 : inter / union
}

function idOf(map: Map<string, number>, key: string): number {
  const known = map.get(key)
  if (known !== undefined) return known
  map.set(key, map.size)
  return map.size - 1
}

function isBox(b: TapeBox | undefined): b is TapeBox {
  return b !== undefined
}

export function buildMetricSequence(
  truth: Truth,
  replay: ReplayResult,
  finalIdOf: (liveId: string) => string,
): MetricSequence {
  if (truth.frames.length !== replay.frames.length) {
    throw new Error(
      `truth has ${String(truth.frames.length)} frames, the replay ${String(replay.frames.length)}`,
    )
  }
  const gtIds = new Map<string, number>()
  const trIds = new Map<string, number>()
  const frames: MetricFrame[] = truth.frames.map((tf, k) => {
    const seenIdentity = new Set<string>()
    const dupDetIds = new Set<string>()
    const dupBoxes: TapeBox[] = []
    const gts = tf.boxes.filter((b) => {
      if (seenIdentity.has(b.identity)) {
        dupDetIds.add(b.detectionId)
        dupBoxes.push(b.box)
        return false
      }
      seenIdentity.add(b.identity)
      return true
    })
    const ignoreDets = new Set([...tf.ignoreDetections, ...dupDetIds])
    const ignoreBoxes = [
      ...tf.ignoreBoxes,
      ...tf.ignoreDetections.map((d) => tf.detectionBoxes.get(d)).filter(isBox),
      ...dupBoxes,
    ]
    const seenFinal = new Set<string>()
    const outs: TapeTrackOutput[] = (replay.frames[k]?.outputs ?? []).filter((o) => {
      if (o.kind === 'coasting') return false
      if (
        o.detectionId !== undefined
          ? ignoreDets.has(o.detectionId)
          : ignoreBoxes.some((b) => iou(b, o.box) >= IGNORE_IOU)
      )
        return false
      const fid = finalIdOf(o.liveId)
      if (seenFinal.has(fid)) return false
      seenFinal.add(fid)
      return true
    })
    return {
      gtIds: gts.map((g) => idOf(gtIds, g.identity)),
      trIds: outs.map((o) => idOf(trIds, finalIdOf(o.liveId))),
      similarity: gts.map((g) =>
        outs.map((o) =>
          o.detectionId !== undefined && o.detectionId === g.detectionId ? 1 : iou(g.box, o.box),
        ),
      ),
    }
  })
  return { numGtIds: gtIds.size, numTrIds: trIds.size, frames }
}
