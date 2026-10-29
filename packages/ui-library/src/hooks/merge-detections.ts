/**
 * Merge of the two live overlay sources into the one flat list the overlay
 * renders. Root boxes ALWAYS come from the raw detector frame; the enriched
 * (post-analysis) frame contributes only EXTRAS — detail children (face,
 * plate…) and identity labels — attached to the matching raw root.
 */
import type { ObjectDetection } from '@camstack/types'

/** Minimum IoU between an enriched root and a raw root to call them one subject
 *  when no trackId pairs them. */
export const EXTRA_MATCH_IOU_THRESHOLD = 0.3

export interface FramePart {
  readonly detections: readonly ObjectDetection[]
  readonly frameWidth: number
  readonly frameHeight: number
}

type Box = ObjectDetection['bbox']
type Label = ObjectDetection['labels'][number]

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a.width * a.height + b.width * b.height - inter
  return union > 0 ? inter / union : 0
}

function isRoot(d: ObjectDetection): boolean {
  return d.kind !== 'detail'
}

function scaleBox(b: Box, sx: number, sy: number): Box {
  return { x: b.x * sx, y: b.y * sy, width: b.width * sx, height: b.height * sy }
}

/** The raw root an enriched root describes: same trackId, else best IoU. */
function matchRawRoot(
  enrichedRoot: ObjectDetection,
  rawRoots: readonly ObjectDetection[],
  sx: number,
  sy: number,
): ObjectDetection | null {
  const trackId = enrichedRoot.track?.trackId
  if (trackId !== undefined) {
    const byTrack = rawRoots.find((r) => r.track?.trackId === trackId)
    if (byTrack) return byTrack
  }
  const scaled = scaleBox(enrichedRoot.bbox, sx, sy)
  let best: ObjectDetection | null = null
  let bestIou = EXTRA_MATCH_IOU_THRESHOLD
  for (const r of rawRoots) {
    const v = iou(scaled, r.bbox)
    if (v >= bestIou) {
      best = r
      bestIou = v
    }
  }
  return best
}

export function mergeDetections(raw: FramePart | null, extras: FramePart | null): FramePart | null {
  if (!extras) return raw
  const frameWidth = raw?.frameWidth ?? extras.frameWidth
  const frameHeight = raw?.frameHeight ?? extras.frameHeight
  const sx = extras.frameWidth > 0 ? frameWidth / extras.frameWidth : 1
  const sy = extras.frameHeight > 0 ? frameHeight / extras.frameHeight : 1
  const rawDets = raw?.detections ?? []
  const rawRoots = rawDets.filter(isRoot)

  const rawRootFor = new Map<string, ObjectDetection | null>()
  const extraLabels = new Map<ObjectDetection, Label[]>()
  for (const root of extras.detections.filter(isRoot)) {
    const match = matchRawRoot(root, rawRoots, sx, sy)
    rawRootFor.set(root.id, match)
    if (match && root.labels.length > 0) {
      extraLabels.set(match, [...(extraLabels.get(match) ?? []), ...root.labels])
    }
  }

  const out: ObjectDetection[] = rawDets.map((d) => {
    const add = extraLabels.get(d)
    if (!add) return d
    const have = new Set(d.labels.map((l) => l.label))
    const fresh = add.filter((l) => !have.has(l.label))
    return fresh.length > 0 ? { ...d, labels: [...d.labels, ...fresh] } : d
  })

  for (const d of extras.detections) {
    if (isRoot(d)) continue
    const parent = d.parentId !== undefined ? rawRootFor.get(d.parentId) : undefined
    out.push({
      ...d,
      bbox: scaleBox(d.bbox, sx, sy),
      ...(parent ? { parentId: parent.id } : {}),
    })
  }
  return { detections: out, frameWidth, frameHeight }
}
