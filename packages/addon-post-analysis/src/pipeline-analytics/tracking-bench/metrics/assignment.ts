/**
 * Minimum-cost rectangular assignment — Kuhn–Munkres with potentials — the
 * TypeScript counterpart of `scipy.optimize.linear_sum_assignment` as TrackEval
 * calls it. Pairs come back sorted by row, like scipy's. On EXACT ties the two
 * may pick different, equally optimal pairs; the specs avoid ties.
 */
export interface Assignment {
  readonly rows: readonly number[]
  readonly cols: readonly number[]
}

type Matrix = readonly (readonly number[])[]

function at(m: Matrix, i: number, j: number): number {
  return m[i]?.[j] ?? 0
}

function transpose(m: Matrix, rows: number, cols: number): number[][] {
  return Array.from({ length: cols }, (_, j) => Array.from({ length: rows }, (_, i) => at(m, i, j)))
}

export function linearSumAssignment(cost: Matrix): Assignment {
  const n0 = cost.length
  const m0 = cost[0]?.length ?? 0
  if (n0 === 0 || m0 === 0) return { rows: [], cols: [] }
  const flip = n0 > m0
  const a: Matrix = flip ? transpose(cost, n0, m0) : cost
  const n = flip ? m0 : n0
  const m = flip ? n0 : m0
  const u = new Array<number>(n + 1).fill(0)
  const v = new Array<number>(m + 1).fill(0)
  const p = new Array<number>(m + 1).fill(0)
  const way = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i += 1) {
    p[0] = i
    let j0 = 0
    const minv = new Array<number>(m + 1).fill(Number.POSITIVE_INFINITY)
    const used = new Array<boolean>(m + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0] ?? 0
      let delta = Number.POSITIVE_INFINITY
      let j1 = 0
      for (let j = 1; j <= m; j += 1) {
        if (used[j] === true) continue
        const cur = at(a, i0 - 1, j - 1) - (u[i0] ?? 0) - (v[j] ?? 0)
        if (cur < (minv[j] ?? Number.POSITIVE_INFINITY)) {
          minv[j] = cur
          way[j] = j0
        }
        const mj = minv[j] ?? Number.POSITIVE_INFINITY
        if (mj < delta) {
          delta = mj
          j1 = j
        }
      }
      for (let j = 0; j <= m; j += 1) {
        if (used[j] === true) {
          const pj = p[j] ?? 0
          u[pj] = (u[pj] ?? 0) + delta
          v[j] = (v[j] ?? 0) - delta
        } else {
          minv[j] = (minv[j] ?? Number.POSITIVE_INFINITY) - delta
        }
      }
      j0 = j1
    } while ((p[j0] ?? 0) !== 0)
    do {
      const j1 = way[j0] ?? 0
      p[j0] = p[j1] ?? 0
      j0 = j1
    } while (j0 !== 0)
  }
  const pairs: [number, number][] = []
  for (let j = 1; j <= m; j += 1) {
    const i = p[j] ?? 0
    if (i !== 0) pairs.push(flip ? [j - 1, i - 1] : [i - 1, j - 1])
  }
  pairs.sort((x, y) => x[0] - y[0])
  return { rows: pairs.map((q) => q[0]), cols: pairs.map((q) => q[1]) }
}
