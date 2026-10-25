import type { RunDetailSubtreeResult } from '@camstack/types'

/** Minimal face-detection detail row for stubbed `runDetailSubtree`. */
export function makeFaceDetailSubtreeResult(
  score: number,
  stepId = 'face-detection',
): RunDetailSubtreeResult {
  return {
    details: [
      {
        stepId,
        className: 'face',
        score,
        bbox: { x: 0, y: 0, w: 40, h: 40 },
      },
    ],
  }
}
