/**
 * The pure half of `BarSeries`: buckets on a fixed grid, optionally stacked,
 * with a total. A bucket the source did not answer is `null` (no bar, not a
 * zero bar); a bucket it answered with nothing is `0`.
 */

/** One bucket: its START and one value per stack layer (`null` = not measured). */
export interface BarBucket {
  readonly t: number
  readonly values: readonly (number | null)[]
}

export interface BarLayerDef {
  readonly id: string
  readonly label: string
  readonly colorIndex: number
}

/** Cumulative tops per layer, bottom layer first: `tops[l][i] = values[0..l]` summed. */
export function stackBuckets(
  buckets: readonly BarBucket[],
  layers: number,
): readonly (readonly (number | null)[])[] {
  const tops: (number | null)[][] = []
  for (let l = 0; l < layers; l++) {
    tops.push(
      buckets.map((b) => {
        let sum: number | null = null
        for (let k = 0; k <= l; k++) {
          const v = b.values[k]
          if (v === null || v === undefined) continue
          sum = (sum ?? 0) + v
        }
        return sum
      }),
    )
  }
  return tops
}

/** Total per layer and overall over the window (unknown buckets add nothing). */
export function bucketTotals(
  buckets: readonly BarBucket[],
  layers: number,
): { readonly perLayer: readonly number[]; readonly total: number; readonly known: boolean } {
  const perLayer = Array.from({ length: layers }, () => 0)
  let known = false
  for (const b of buckets) {
    for (let l = 0; l < layers; l++) {
      const v = b.values[l]
      if (v === null || v === undefined) continue
      known = true
      perLayer[l] = (perLayer[l] ?? 0) + v
    }
  }
  return { perLayer, total: perLayer.reduce((a, b) => a + b, 0), known }
}

/** Index of the bucket that holds `t`, or `null`. */
export function bucketIndexAt(
  buckets: readonly BarBucket[],
  bucketMs: number,
  t: number,
): number | null {
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]
    if (b && t >= b.t && t < b.t + bucketMs) return i
  }
  return null
}
