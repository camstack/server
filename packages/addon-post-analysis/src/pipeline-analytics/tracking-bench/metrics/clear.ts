/**
 * CLEAR MOT (Bernardin & Stiefelhagen 2008) exactly as TrackEval's
 * `CLEAR.eval_sequence` computes it — including its quirks: a frame with no
 * tracker detections does not reset the "tracked last frame" memory, and a
 * continuing match gets a 1000× bonus before the threshold zeroes it.
 */
import { linearSumAssignment } from './assignment.js'
import { countDets, EPS, type MetricSequence, sim } from './metric-sequence.js'

export interface ClearResult {
  readonly MOTA: number
  readonly MOTP: number
  readonly IDSW: number
  readonly Frag: number
  readonly CLR_TP: number
  readonly CLR_FN: number
  readonly CLR_FP: number
  readonly MT: number
  readonly PT: number
  readonly ML: number
}

export function computeClear(seq: MetricSequence, threshold = 0.5): ClearResult {
  const dets = countDets(seq)
  const G = seq.numGtIds
  const empty = { IDSW: 0, Frag: 0, MT: 0, PT: 0, MOTP: 0, MOTA: 0 }
  if (dets.tr === 0) return { ...empty, CLR_TP: 0, CLR_FN: dets.gt, CLR_FP: 0, ML: G }
  if (dets.gt === 0) return { ...empty, CLR_TP: 0, CLR_FN: 0, CLR_FP: dets.tr, ML: G }
  let TP = 0
  let FN = 0
  let FP = 0
  let IDSW = 0
  let motpSum = 0
  const gtCount = new Array<number>(G).fill(0)
  const matchedCount = new Array<number>(G).fill(0)
  const fragCount = new Array<number>(G).fill(0)
  const prevTracker = new Array<number | null>(G).fill(null)
  let prevStep = new Array<number | null>(G).fill(null)
  for (const f of seq.frames) {
    if (f.gtIds.length === 0) {
      FP += f.trIds.length
      continue
    }
    if (f.trIds.length === 0) {
      FN += f.gtIds.length
      for (const g of f.gtIds) gtCount[g] = (gtCount[g] ?? 0) + 1
      continue
    }
    const score = f.gtIds.map((g, i) =>
      f.trIds.map((t, j) => {
        const s = sim(f, i, j)
        if (s < threshold - EPS) return 0
        return (prevStep[g] === t ? 1000 : 0) + s
      }),
    )
    const { rows, cols } = linearSumAssignment(score.map((row) => row.map((x) => -x)))
    const matched: [number, number, number][] = []
    rows.forEach((r, k) => {
      const c = cols[k] ?? 0
      if ((score[r]?.[c] ?? 0) > 0 + EPS) matched.push([r, c, sim(f, r, c)])
    })
    for (const [r, c] of matched) {
      const g = f.gtIds[r] ?? 0
      const t = f.trIds[c] ?? 0
      const prev = prevTracker[g] ?? null
      if (prev !== null && prev !== t) IDSW += 1
    }
    for (const g of f.gtIds) gtCount[g] = (gtCount[g] ?? 0) + 1
    const notPreviouslyTracked = prevStep.map((x) => x === null)
    const nextStep = new Array<number | null>(G).fill(null)
    for (const [r, c, s] of matched) {
      const g = f.gtIds[r] ?? 0
      const t = f.trIds[c] ?? 0
      matchedCount[g] = (matchedCount[g] ?? 0) + 1
      prevTracker[g] = t
      nextStep[g] = t
      motpSum += s
    }
    prevStep = nextStep
    prevStep.forEach((x, g) => {
      if (x !== null && notPreviouslyTracked[g] === true) fragCount[g] = (fragCount[g] ?? 0) + 1
    })
    TP += matched.length
    FN += f.gtIds.length - matched.length
    FP += f.trIds.length - matched.length
  }
  const ratios: number[] = []
  gtCount.forEach((n, g) => {
    if (n > 0) ratios.push((matchedCount[g] ?? 0) / n)
  })
  const MT = ratios.filter((r) => r > 0.8).length
  const PT = ratios.filter((r) => r >= 0.2).length - MT
  return {
    CLR_TP: TP,
    CLR_FN: FN,
    CLR_FP: FP,
    IDSW,
    MOTP: motpSum / Math.max(1, TP),
    MOTA: (TP - FP - IDSW) / Math.max(1, TP + FN),
    MT,
    PT,
    ML: G - MT - PT,
    Frag: fragCount.filter((x) => x > 0).reduce((s, x) => s + (x - 1), 0),
  }
}
