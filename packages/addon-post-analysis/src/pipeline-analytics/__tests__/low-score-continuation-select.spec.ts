import type { DiscardedDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { selectLowScoreContinuations } from '../pipeline/tracker/low-score-continuation.js'

function drop(
  macroClass: string,
  score: number,
  reason: DiscardedDetection['reason'] = 'below-threshold',
): DiscardedDetection {
  return { bbox: [10, 20, 70, 170], macroClass, score, reason }
}

describe('selectLowScoreContinuations (D665)', () => {
  it('takes below-threshold person/animal boxes at or above the floor, as rectangles', () => {
    expect(selectLowScoreContinuations([drop('person', 0.5)], 0.35)).toEqual([
      {
        class: 'person',
        originalClass: 'person',
        score: 0.5,
        bbox: { x: 10, y: 20, w: 60, h: 150 },
      },
    ])
    expect(selectLowScoreContinuations([drop('animal', 0.35)], 0.35)).toHaveLength(1)
  })

  it('refuses everything else: under the floor, other reasons, vehicles, tier off', () => {
    expect(selectLowScoreContinuations([drop('person', 0.34)], 0.35)).toEqual([])
    expect(selectLowScoreContinuations([drop('person', 0.5, 'class-filter')], 0.35)).toEqual([])
    expect(selectLowScoreContinuations([drop('person', 0.5, 'zone-gate')], 0.35)).toEqual([])
    expect(selectLowScoreContinuations([drop('person', 0.5, 'full-frame-guard')], 0.35)).toEqual([])
    expect(selectLowScoreContinuations([drop('vehicle', 0.6)], 0.35)).toEqual([])
    expect(selectLowScoreContinuations([drop('person', 0.6)], null)).toEqual([])
    expect(selectLowScoreContinuations(undefined, 0.35)).toEqual([])
  })
})
