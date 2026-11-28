/** A training result with an INT8 build and two per-camera recall changes, for the comparison table shot. */
import type { TrainingResult } from '@dominevo/types'

const CLASS = {
  positives: 120,
  floor: 0.6,
  tp: 96,
  fp: 8,
  fn: 24,
  precision: 0.923,
  recall: 0.8,
  ap50: 0.871,
  recallByLight: { night: 0.71 },
  smallFound: 9,
  smallTotal: 20,
}

export const COMPARISON_RESULT = {
  evaluation: {
    baseline: { classes: { person: CLASS, vehicle: { ...CLASS, positives: 64, recall: 0.74 } } },
    candidate: {
      classes: {
        person: { ...CLASS, recall: 0.88, ap50: 0.92 },
        vehicle: { ...CLASS, positives: 64, recall: 0.81 },
      },
    },
    candidateInt8: {
      classes: {
        person: { ...CLASS, recall: 0.86 },
        vehicle: { ...CLASS, positives: 64, recall: 0.79 },
      },
    },
    recallDeltaByCamera: { person: { '101': 0.06, '102': -0.03 } },
  },
  // Documented type boundary: the comparison table reads only `evaluation`.
} as unknown as TrainingResult
