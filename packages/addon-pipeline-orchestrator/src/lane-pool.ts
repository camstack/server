/**
 * Bounded-concurrency `map` for I/O-bound work — the D167 lane pool.
 *
 * **This is a PORT, not a new primitive.** The shape is the repo's, and the
 * canonical siblings are `spawnPlanConcurrently`
 * (`server/backend/src/core/addon/runner-spawn-fanout.ts`),
 * `hydrateDevicesFromStorage` (`addon-pipeline/src/recorder/addon/roots.ts`),
 * `BaseDeviceProvider.onRestoreDevices` and `mapWithConcurrency`
 * (`addon-post-analysis/src/pipeline-analytics/map-with-concurrency.ts`). It is
 * copied rather than imported because neither of the two ways to share it is
 * deployable: an addon may never import another addon (`ctx.api` is the only
 * cross-addon layer), and `@camstack/types` is an EXTERNAL of every addon bundle
 * — a helper placed there is not live until a `@camstack/server` train installs
 * it, while this file ships with `camstack deploy`.
 *
 * Why bounded rather than a plain `Promise.all`: every unit here is a UDS
 * round-trip on a channel the LIVE detection path shares. Unbounded, a boot
 * sweep over the fleet trades a slow sweep for a stalled pipeline.
 *
 * Order is preserved — results are written back by index, never by completion —
 * so a caller may still pair a result with its input. Nothing may depend on the
 * order units RAN in; that is exactly what D167 makes unobservable.
 */

/** Maps one input to its result. Receives the index so a mapper can log position. */
export type LaneMapper<TIn, TOut> = (item: TIn, index: number) => Promise<TOut>

/**
 * Apply `mapper` to every item with at most `limit` in flight at once.
 *
 * A rejecting mapper rejects the whole call (same contract as `Promise.all`);
 * a caller that must not fail the sweep for one bad unit catches INSIDE the
 * mapper — which is what every caller in this package does, because a unit that
 * threw must never be the reason the next camera is not hydrated.
 */
export async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  limit: number,
  mapper: LaneMapper<TIn, TOut>,
): Promise<TOut[]> {
  const results: TOut[] = new Array<TOut>(items.length)
  if (items.length === 0) return results

  // A shared cursor beats slicing into chunks: chunking makes every lane wait
  // for the SLOWEST member of its chunk, which is exactly the stall a mixed
  // fast-store/slow-store workload produces.
  //
  // The cursor IS the iterator: `entries()` hands back `[index, item]` already
  // paired, so no lane ever indexes back into `items` and the element type stays
  // `TIn` without a cast or a non-null assertion. Concurrent `for…of` loops over
  // ONE iterator interleave safely — `next()` is synchronous, so a lane's pull
  // completes before any other lane can run.
  const lanes = Math.max(1, Math.min(Math.trunc(limit), items.length))
  const entries = items.entries()

  const lane = async (): Promise<void> => {
    for (const [index, item] of entries) {
      results[index] = await mapper(item, index)
    }
  }

  await Promise.all(Array.from({ length: lanes }, () => lane()))
  return results
}
