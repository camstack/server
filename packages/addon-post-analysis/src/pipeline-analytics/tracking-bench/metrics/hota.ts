/**
 * HOTA (Luiten et al., IJCV 2020) exactly as TrackEval's `HOTA.eval_sequence`
 * computes it: a global alignment score from soft (IoU-of-similarity) matches,
 * then per α a Hungarian match on alignment × similarity. Reported values are
 * the means over the 19 α of `np.arange(0.05, 0.99, 0.05)`.
 */
import { linearSumAssignment } from './assignment.js'
import { countDets, EPS, type MetricSequence, sim } from './metric-sequence.js'

const HOTA_ALPHAS: readonly number[] = Array.from({ length: 19 }, (_, i) => 0.05 + i * 0.05)

export interface HotaResult {
  readonly HOTA: number
  readonly DetA: number
  readonly AssA: number
  readonly LocA: number
  readonly DetRe: number
  readonly DetPr: number
  readonly AssRe: number
  readonly AssPr: number
}

function mean(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
}

function matrix(rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
}

export function computeHota(seq: MetricSequence): HotaResult {
  const A = HOTA_ALPHAS.length
  const dets = countDets(seq)
  const TP = new Array<number>(A).fill(0)
  const FN = new Array<number>(A).fill(0)
  const FP = new Array<number>(A).fill(0)
  const LocSum = new Array<number>(A).fill(0)
  const AssA = new Array<number>(A).fill(0)
  const AssRe = new Array<number>(A).fill(0)
  const AssPr = new Array<number>(A).fill(0)
  if (dets.tr === 0 || dets.gt === 0) {
    const fn = dets.tr === 0 ? dets.gt : 0
    const fp = dets.gt === 0 ? dets.tr : 0
    const detRe = 0 / Math.max(1, fn)
    return {
      HOTA: 0,
      DetA: 0,
      AssA: 0,
      LocA: 1,
      DetRe: detRe,
      DetPr: 0 / Math.max(1, fp),
      AssRe: 0,
      AssPr: 0,
    }
  }
  const G = seq.numGtIds
  const T = seq.numTrIds
  const potential = matrix(G, T)
  const gtCount = new Array<number>(G).fill(0)
  const trCount = new Array<number>(T).fill(0)
  for (const f of seq.frames) {
    const colSum = f.trIds.map((_, j) => f.gtIds.reduce((s, _g, i) => s + sim(f, i, j), 0))
    const rowSum = f.gtIds.map((_, i) => f.trIds.reduce((s, _t, j) => s + sim(f, i, j), 0))
    f.gtIds.forEach((g, i) => {
      f.trIds.forEach((t, j) => {
        const s = sim(f, i, j)
        const denom = (colSum[j] ?? 0) + (rowSum[i] ?? 0) - s
        const row = potential[g]
        if (row !== undefined && denom > 0 + EPS) row[t] = (row[t] ?? 0) + s / denom
      })
      gtCount[g] = (gtCount[g] ?? 0) + 1
    })
    for (const t of f.trIds) trCount[t] = (trCount[t] ?? 0) + 1
  }
  const align = potential.map((row, g) =>
    row.map((pm, t) => pm / ((gtCount[g] ?? 0) + (trCount[t] ?? 0) - pm)),
  )
  const matches = HOTA_ALPHAS.map(() => matrix(G, T))
  for (const f of seq.frames) {
    if (f.gtIds.length === 0) {
      for (let a = 0; a < A; a += 1) FP[a] = (FP[a] ?? 0) + f.trIds.length
      continue
    }
    if (f.trIds.length === 0) {
      for (let a = 0; a < A; a += 1) FN[a] = (FN[a] ?? 0) + f.gtIds.length
      continue
    }
    const score = f.gtIds.map((g, i) => f.trIds.map((t, j) => (align[g]?.[t] ?? 0) * sim(f, i, j)))
    const { rows, cols } = linearSumAssignment(score.map((row) => row.map((x) => -x)))
    HOTA_ALPHAS.forEach((alpha, a) => {
      let n = 0
      rows.forEach((r, k) => {
        const c = cols[k] ?? 0
        const s = sim(f, r, c)
        if (s < alpha - EPS) return
        n += 1
        LocSum[a] = (LocSum[a] ?? 0) + s
        const row = matches[a]?.[f.gtIds[r] ?? 0]
        const t = f.trIds[c] ?? 0
        if (row !== undefined) row[t] = (row[t] ?? 0) + 1
      })
      TP[a] = (TP[a] ?? 0) + n
      FN[a] = (FN[a] ?? 0) + f.gtIds.length - n
      FP[a] = (FP[a] ?? 0) + f.trIds.length - n
    })
  }
  const hota: number[] = []
  const detA: number[] = []
  const locA: number[] = []
  const detRe: number[] = []
  const detPr: number[] = []
  for (let a = 0; a < A; a += 1) {
    let assA = 0
    let assRe = 0
    let assPr = 0
    matches[a]?.forEach((row, g) =>
      row.forEach((mc, t) => {
        if (mc === 0) return
        assA += (mc * mc) / Math.max(1, (gtCount[g] ?? 0) + (trCount[t] ?? 0) - mc)
        assRe += (mc * mc) / Math.max(1, gtCount[g] ?? 0)
        assPr += (mc * mc) / Math.max(1, trCount[t] ?? 0)
      }),
    )
    const tp = TP[a] ?? 0
    const fn = FN[a] ?? 0
    const fp = FP[a] ?? 0
    AssA[a] = assA / Math.max(1, tp)
    AssRe[a] = assRe / Math.max(1, tp)
    AssPr[a] = assPr / Math.max(1, tp)
    const da = tp / Math.max(1, tp + fn + fp)
    detA.push(da)
    detRe.push(tp / Math.max(1, tp + fn))
    detPr.push(tp / Math.max(1, tp + fp))
    locA.push(Math.max(1e-10, LocSum[a] ?? 0) / Math.max(1e-10, tp))
    hota.push(Math.sqrt(da * (AssA[a] ?? 0)))
  }
  return {
    HOTA: mean(hota),
    DetA: mean(detA),
    AssA: mean(AssA),
    LocA: mean(locA),
    DetRe: mean(detRe),
    DetPr: mean(detPr),
    AssRe: mean(AssRe),
    AssPr: mean(AssPr),
  }
}
