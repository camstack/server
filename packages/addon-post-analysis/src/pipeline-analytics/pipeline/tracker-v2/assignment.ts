/**
 * Min-cost one-to-one assignment (Hungarian, potentials form, O(n³)).
 *
 * Used by L1 (tracklets × detections) and L2 (ended pieces × later pieces).
 * `FORBIDDEN` marks a pair that must never be matched; a row whose only
 * options are forbidden stays unassigned. Deterministic: ties resolve by the
 * algorithm's fixed scan order, never by a random draw.
 */
export const FORBIDDEN = Number.POSITIVE_INFINITY

export interface AssignedPair {
  readonly row: number
  readonly col: number
  readonly cost: number
}

/** A cost no real pair reaches: forbidden pairs are solved with it, then dropped. */
const SOLVER_BIG = 1e9

function at(arr: Float64Array | Int32Array, i: number): number {
  return arr[i] ?? 0
}

export function minCostAssignment(cost: readonly (readonly number[])[]): readonly AssignedPair[] {
  const rows = cost.length
  const cols = rows === 0 ? 0 : (cost[0]?.length ?? 0)
  if (rows === 0 || cols === 0) return []
  const n = Math.max(rows, cols)
  const cell = (i: number, j: number): number => {
    if (i >= rows || j >= cols) return 0
    const v = cost[i]?.[j] ?? FORBIDDEN
    return Number.isFinite(v) ? v : SOLVER_BIG
  }
  const u = new Float64Array(n + 1)
  const v = new Float64Array(n + 1)
  const p = new Int32Array(n + 1)
  const way = new Int32Array(n + 1)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY)
    const used = new Uint8Array(n + 1)
    do {
      used[j0] = 1
      const i0 = at(p, j0)
      let delta = Number.POSITIVE_INFINITY
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j] === 1) continue
        const cur = cell(i0 - 1, j - 1) - at(u, i0) - at(v, j)
        if (cur < at(minv, j)) {
          minv[j] = cur
          way[j] = j0
        }
        if (at(minv, j) < delta) {
          delta = at(minv, j)
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j] === 1) {
          const pj = at(p, j)
          u[pj] = at(u, pj) + delta
          v[j] = at(v, j) - delta
        } else {
          minv[j] = at(minv, j) - delta
        }
      }
      j0 = j1
    } while (at(p, j0) !== 0)
    do {
      const j1 = at(way, j0)
      p[j0] = at(p, j1)
      j0 = j1
    } while (j0 !== 0)
  }
  const pairs: AssignedPair[] = []
  for (let j = 1; j <= n; j++) {
    const i = at(p, j)
    if (i === 0 || i - 1 >= rows || j - 1 >= cols) continue
    const c = cost[i - 1]?.[j - 1] ?? FORBIDDEN
    if (!Number.isFinite(c)) continue
    pairs.push({ row: i - 1, col: j - 1, cost: c })
  }
  return pairs.sort((a, b) => a.row - b.row)
}
