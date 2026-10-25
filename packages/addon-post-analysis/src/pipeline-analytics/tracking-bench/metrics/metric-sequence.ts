/**
 * One sequence in TrackEval's own terms (D681): per frame, the integer ids of
 * the ground-truth and tracker detections present and a gt × tracker
 * similarity matrix. Every standard metric here consumes exactly this — the
 * shape TrackEval uses, so a number can be compared by hand with its source.
 */
export const EPS = 2.220446049250313e-16

export interface MetricFrame {
  readonly gtIds: readonly number[]
  readonly trIds: readonly number[]
  /** `similarity[i][j]` for `gtIds[i]` × `trIds[j]`. */
  readonly similarity: readonly (readonly number[])[]
}

export interface MetricSequence {
  readonly numGtIds: number
  readonly numTrIds: number
  readonly frames: readonly MetricFrame[]
}

export interface DetCounts {
  readonly gt: number
  readonly tr: number
}

export function countDets(seq: MetricSequence): DetCounts {
  let gt = 0
  let tr = 0
  for (const f of seq.frames) {
    gt += f.gtIds.length
    tr += f.trIds.length
  }
  return { gt, tr }
}

export function sim(f: MetricFrame, i: number, j: number): number {
  return f.similarity[i]?.[j] ?? 0
}
