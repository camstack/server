/**
 * Bounded-concurrency `map` for I/O-bound work.
 *
 * The gallery surfaces resolve one blob PER ROW — a store round-trip plus a
 * disk read each — and a `for … await` over the page makes those strictly
 * sequential. At the page size the Faces view actually asks for (500) that is
 * ~1000 serial I/O operations, measured at 9.5 s warm and 61 s cold against the
 * live hub, paid again on every operator assign and on every 30 s poll.
 *
 * Concurrency is BOUNDED rather than a plain `Promise.all`: the unbounded form
 * would open 500 simultaneous store requests on a UDS channel shared with the
 * live detection path, trading a slow page for a stalled pipeline.
 *
 * Order is preserved — results are written back by index, never by completion —
 * because every caller here renders a list whose ordering is the query's
 * (`timestamp DESC`), not the I/O scheduler's.
 */

/** Maps one input to its result. Receives the index so a mapper can log position. */
export type ConcurrentMapper<TIn, TOut> = (item: TIn, index: number) => Promise<TOut>

/**
 * Apply `mapper` to every item with at most `limit` in flight at once.
 *
 * A rejecting mapper rejects the whole call (same contract as `Promise.all`);
 * callers that must not fail a page for one bad row catch inside the mapper.
 */
export async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  limit: number,
  mapper: ConcurrentMapper<TIn, TOut>,
): Promise<TOut[]> {
  const results: TOut[] = new Array<TOut>(items.length)
  if (items.length === 0) return results

  // A shared cursor beats slicing into chunks: chunking makes every worker wait
  // for the SLOWEST member of its chunk, which is exactly the stall a mixed
  // cache-hit/disk-read workload produces.
  //
  // The cursor IS the iterator: `entries()` hands back `[index, item]` already
  // paired, so no worker ever indexes back into `items` and the element type
  // stays `TIn` without a cast or a non-null assertion. Concurrent `for…of`
  // loops over ONE iterator interleave safely — `next()` is synchronous, so a
  // worker's pull completes before any other worker can run.
  const effectiveLimit = Math.max(1, Math.min(Math.trunc(limit), items.length))
  const entries = items.entries()

  const worker = async (): Promise<void> => {
    for (const [index, item] of entries) {
      results[index] = await mapper(item, index)
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, () => worker()))
  return results
}
