import type { DetectionBoundingBox, MacroClass, ObjectDetection } from '@camstack/types'

/** Minimal first-level {@link ObjectDetection} for pipeline-runner specs. */
export function makeObjectDetection(
  patch: Partial<ObjectDetection> &
    Pick<ObjectDetection, 'id'> & {
      readonly macroClass?: MacroClass
      readonly score?: number
      readonly bbox?: DetectionBoundingBox
    },
): ObjectDetection {
  return {
    kind: 'first-level',
    macroClass: patch.macroClass ?? 'person',
    score: patch.score ?? 0.9,
    labels: patch.labels ?? [],
    bbox: patch.bbox ?? { x: 100, y: 100, width: 200, height: 200 },
    ...patch,
  }
}
