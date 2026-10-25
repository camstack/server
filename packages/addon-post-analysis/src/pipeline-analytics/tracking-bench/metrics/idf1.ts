/**
 * The Identity metrics (Ristani et al. 2016) exactly as TrackEval's
 * `Identity.eval_sequence` computes them: a global bipartite matching of gt
 * ids to tracker ids on an (n+m)² cost matrix of false negatives + false
 * positives.
 */
import { linearSumAssignment } from './assignment.js'
import { countDets, EPS, type MetricSequence, sim } from './metric-sequence.js'

export interface IdentityResult {
  readonly IDTP: number
  readonly IDFN: number
  readonly IDFP: number
  readonly IDR: number
  readonly IDP: number
  readonly IDF1: number
}

const UNMATCHABLE = 1e10

function finalize(IDTP: number, IDFN: number, IDFP: number): IdentityResult {
  return {
    IDTP,
    IDFN,
    IDFP,
    IDR: IDTP / Math.max(1, IDTP + IDFN),
    IDP: IDTP / Math.max(1, IDTP + IDFP),
    IDF1: IDTP / Math.max(1, IDTP + 0.5 * IDFP + 0.5 * IDFN),
  }
}

export function computeIdentity(seq: MetricSequence, threshold = 0.5): IdentityResult {
  const dets = countDets(seq)
  if (dets.tr === 0) return { ...finalize(0, dets.gt, 0), IDF1: 0, IDR: 0, IDP: 0 }
  if (dets.gt === 0) return { ...finalize(0, 0, dets.tr), IDF1: 0, IDR: 0, IDP: 0 }
  const G = seq.numGtIds
  const T = seq.numTrIds
  const potential = Array.from({ length: G }, () => new Array<number>(T).fill(0))
  const gtCount = new Array<number>(G).fill(0)
  const trCount = new Array<number>(T).fill(0)
  for (const f of seq.frames) {
    f.gtIds.forEach((g, i) => {
      f.trIds.forEach((t, j) => {
        if (sim(f, i, j) >= threshold - EPS) {
          const row = potential[g]
          if (row !== undefined) row[t] = (row[t] ?? 0) + 1
        }
      })
      gtCount[g] = (gtCount[g] ?? 0) + 1
    })
    for (const t of f.trIds) trCount[t] = (trCount[t] ?? 0) + 1
  }
  const size = G + T
  const fn = Array.from({ length: size }, () => new Array<number>(size).fill(0))
  const fp = Array.from({ length: size }, () => new Array<number>(size).fill(0))
  const set = (m: number[][], i: number, j: number, value: number): void => {
    const row = m[i]
    if (row !== undefined) row[j] = value
  }
  for (let i = G; i < size; i += 1) for (let j = 0; j < T; j += 1) set(fp, i, j, UNMATCHABLE)
  for (let i = 0; i < G; i += 1) for (let j = T; j < size; j += 1) set(fn, i, j, UNMATCHABLE)
  for (let g = 0; g < G; g += 1) {
    for (let t = 0; t < T; t += 1) set(fn, g, t, gtCount[g] ?? 0)
    set(fn, g, T + g, gtCount[g] ?? 0)
  }
  for (let t = 0; t < T; t += 1) {
    for (let g = 0; g < G; g += 1) set(fp, g, t, trCount[t] ?? 0)
    set(fp, t + G, t, trCount[t] ?? 0)
  }
  for (let g = 0; g < G; g += 1) {
    for (let t = 0; t < T; t += 1) {
      const pm = potential[g]?.[t] ?? 0
      set(fn, g, t, (fn[g]?.[t] ?? 0) - pm)
      set(fp, g, t, (fp[g]?.[t] ?? 0) - pm)
    }
  }
  const total = fn.map((row, i) => row.map((x, j) => x + (fp[i]?.[j] ?? 0)))
  const { rows, cols } = linearSumAssignment(total)
  let IDFN = 0
  let IDFP = 0
  rows.forEach((r, k) => {
    const c = cols[k] ?? 0
    IDFN += fn[r]?.[c] ?? 0
    IDFP += fp[r]?.[c] ?? 0
  })
  const IDTP = gtCount.reduce((s, x) => s + x, 0) - IDFN
  return finalize(IDTP, IDFN, IDFP)
}
