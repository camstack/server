/**
 * Ground truth generation, loading, and IoU-based comparison for E2E tests.
 *
 * Updated for the Phase 6 detection output rework: operates on the
 * new `FrameResult` / `ObjectDetection` shape. Ground-truth files are
 * rewritten to mirror the new data model — detail entries (face,
 * plate) live flat at the root with `parentId`, labels are typed as
 * `ScoredLabel[]`, and timings come from `frame.debug.stepTimings`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { FrameResult, ObjectDetection, ScoredLabel } from '@camstack/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GroundTruthAnnotation {
  readonly id: string
  readonly kind: 'first-level' | 'detail'
  readonly macroClass: string
  readonly score: number
  readonly bbox: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly labels: readonly ScoredLabel[]
  readonly parentId?: string
}

export interface GroundTruthFile {
  readonly image: string
  readonly width: number
  readonly height: number
  readonly generatedAt: string
  readonly engine: string
  readonly annotations: readonly GroundTruthAnnotation[]
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

function detectionToAnnotation(det: ObjectDetection): GroundTruthAnnotation {
  return {
    id: det.id,
    kind: det.kind,
    macroClass: det.macroClass,
    score: Math.round(det.score * 1000) / 1000,
    bbox: { ...det.bbox },
    labels: det.labels.map((l) => ({
      label: l.label,
      score: Math.round(l.score * 1000) / 1000,
      ...(l.detectionId !== undefined ? { detectionId: l.detectionId } : {}),
    })),
    ...(det.parentId !== undefined ? { parentId: det.parentId } : {}),
  }
}

export function generateGroundTruth(
  imageName: string,
  result: FrameResult,
  engine: string,
): GroundTruthFile {
  return {
    image: imageName,
    width: result.width,
    height: result.height,
    generatedAt: new Date().toISOString(),
    engine,
    annotations: result.detections.map(detectionToAnnotation),
  }
}

export function saveGroundTruth(gtDir: string, gt: GroundTruthFile): void {
  const filename = path.basename(gt.image, path.extname(gt.image)) + '.json'
  fs.mkdirSync(gtDir, { recursive: true })
  fs.writeFileSync(path.join(gtDir, filename), JSON.stringify(gt, null, 2) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export function loadGroundTruth(gtDir: string, imageName: string): GroundTruthFile | null {
  const filename = path.basename(imageName, path.extname(imageName)) + '.json'
  const filepath = path.join(gtDir, filename)
  if (!fs.existsSync(filepath)) return null
  return JSON.parse(fs.readFileSync(filepath, 'utf8')) as GroundTruthFile
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function iou(a: Rect, b: Rect): number {
  const ax2 = a.x + a.width
  const ay2 = a.y + a.height
  const bx2 = b.x + b.width
  const by2 = b.y + b.height
  const ix1 = Math.max(a.x, b.x)
  const iy1 = Math.max(a.y, b.y)
  const ix2 = Math.min(ax2, bx2)
  const iy2 = Math.min(ay2, by2)
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
  if (inter === 0) return 0
  const areaA = a.width * a.height
  const areaB = b.width * b.height
  return inter / (areaA + areaB - inter)
}

export interface ComparisonResult {
  readonly matched: number
  readonly missed: number
  readonly extra: number
  readonly details: readonly {
    expected: GroundTruthAnnotation
    actual: ObjectDetection | null
    iou: number
    classMatch: boolean
    labelsMatch: boolean
  }[]
}

/**
 * Compare a frame result against ground truth. Matches detections by
 * (macroClass, IoU) and additionally verifies that every ground-truth
 * enrichment label is present on the matched actual detection (order
 * insensitive, case sensitive).
 */
export function compareWithGroundTruth(
  result: FrameResult,
  gt: GroundTruthFile,
  iouThreshold = 0.5,
): ComparisonResult {
  const actuals = [...result.detections]
  const details: ComparisonResult['details'][number][] = []

  for (const expected of gt.annotations) {
    let bestIdx = -1
    let bestIou = 0

    for (let i = 0; i < actuals.length; i++) {
      const a = actuals[i]!
      if (a.macroClass !== expected.macroClass) continue
      if (a.kind !== expected.kind) continue
      const score = iou(expected.bbox, a.bbox)
      if (score > bestIou) {
        bestIou = score
        bestIdx = i
      }
    }

    if (bestIdx >= 0 && bestIou >= iouThreshold) {
      const actual = actuals.splice(bestIdx, 1)[0]!
      const expectedLabels = new Set(expected.labels.map((l) => l.label))
      const actualLabels = new Set(actual.labels.map((l) => l.label))
      const labelsMatch = [...expectedLabels].every((l) => actualLabels.has(l))
      details.push({ expected, actual, iou: bestIou, classMatch: true, labelsMatch })
    } else {
      details.push({ expected, actual: null, iou: bestIou, classMatch: false, labelsMatch: false })
    }
  }

  const matched = details.filter((d) => d.actual !== null).length
  return { matched, missed: details.length - matched, extra: actuals.length, details }
}
