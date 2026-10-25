/**
 * Bounded-parallel map with input order preserved.
 *
 * Exists because every intent here fans out over a device list where each item
 * is 2–3 sequential cross-process tRPC reads. `Promise.all` over a 300-device
 * Home-Assistant-imported fleet stampedes a booting hub; a serial loop makes
 * the answer scale linearly in fleet size, which Alexa's discovery already
 * measured in minutes for 21 cameras.
 *
 * Batched rather than a rolling lane pool. A pool is marginally better when one
 * item is much slower than its neighbours, but it needs a pre-sized result
 * array written by index — and a pre-sized `TOut[]` cannot be produced without
 * either a cast or an `undefined` hole in the element type. Batching preserves
 * order by construction and costs six lines.
 */
export async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  lanes: number,
  work: (item: TIn) => Promise<TOut>,
): Promise<readonly TOut[]> {
  const size = Math.max(1, lanes)
  const out: TOut[] = []
  for (let start = 0; start < items.length; start += size) {
    out.push(...(await Promise.all(items.slice(start, start + size).map(work))))
  }
  return out
}
