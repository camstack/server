/**
 * Native-allocator environment for a forked addon runner.
 *
 * ## The half of a runner's memory that no V8 flag reaches
 *
 * `--max-old-space-size` bounds V8's old space and nothing else. It does not
 * bound `external`, it does not bound `arrayBuffers`, and it does not bound what
 * a native addon (`sharp`/`libvips`, decoders, codecs) allocates through `malloc`.
 *
 * Measured on the live hub, 2026-08-25, over a ~6h window of `[mem]` heartbeats:
 *
 *   hub/pipeline-analytics  rss 309-7334MB   heapTotal max 343MB   external max 5479MB
 *
 * It already carried `--max-old-space-size=1024`, so the flag was in force the
 * whole time and the process still reached 7.3GB — because 96% of it was never
 * V8's to bound. Its reclaim line names the shape exactly:
 *
 *   reclaim hub/pipeline-analytics stranded=2552MB rss=2765MB→2647MB
 *           freed=118MB arrayBuffers=81MB→29MB took=58ms
 *
 * The `arrayBuffers` FLOOR returns to ~1MB every cycle, so this is not a leak.
 * It is glibc holding freed pages: with `MALLOC_ARENA_MAX` unset, glibc opens up
 * to `8 × ncpu` arenas — 160 on this 20-core host — and each keeps its own free
 * list, which is returned to the OS only when the top of that arena is free.
 *
 * ## Why this matters more than the cgroup number suggests
 *
 * The container is capped at 24GiB and `memory.current` rides at 21-24GB. Near
 * the limit the kernel performs direct reclaim IN THE CONTEXT OF THE TASK THAT
 * ALLOCATES, so every process in the container stalls together — measured as
 * four idle, mutually unrelated runners sharing one ~39s stall in the same
 * sample. Returning stranded pages is therefore not a tidiness win; it is what
 * keeps unrelated runners off the direct-reclaim path.
 *
 * ## Why `VIPS_CONCURRENCY` is welded to it
 *
 * `sharp` reads `MALLOC_ARENA_MAX` in its NATIVE binding (not in JS — grepping
 * the bundle finds nothing). Unset on glibc, sharp pins libvips concurrency to 1
 * as its own fragmentation defence; the moment the variable appears it restores
 * concurrency to `availableParallelism()`. Verified in the live container:
 *
 *   MALLOC_ARENA_MAX unset                  → sharp.concurrency() === 1
 *   MALLOC_ARENA_MAX=2                      → sharp.concurrency() === 20
 *   MALLOC_ARENA_MAX=2 VIPS_CONCURRENCY=1   → sharp.concurrency() === 1
 *
 * Shipping the arena bound alone would therefore have quietly shipped a 1→20
 * libvips threading change to the busiest addon on a host already at ~75% CPU,
 * under the banner of a memory fix. This module ships the allocator change and
 * ONLY the allocator change; raising libvips concurrency is a separate decision.
 *
 * ## What it costs, measured
 *
 * Same container, same 12-image corpus, same pipeline as analytics (decode →
 * extract → resize → encode → raw), 3 interleaved pairs so host load cancels,
 * concurrency pinned to 1 on both arms:
 *
 *   arenas default : mean 51.9ms  p50 60.0ms  p90 67.3ms  p99 70.7ms  rss 505MB
 *   arenas=2       : mean 51.5ms  p50 57.6ms  p90 67.2ms  p99 72.9ms  rss 354MB
 *
 * Latency is unchanged inside noise (-0.8% mean, +3.1% p99); the same work is
 * done in 30% less RSS.
 */

/** Bounded glibc arenas per forked runner. */
export const RUNNER_MALLOC_ARENA_MAX_DEFAULT = 2

/**
 * libvips worker threads per forked runner. `1` is not a tuning choice — it is
 * sharp's OWN default on glibc, pinned here so that bounding the arenas does not
 * change it as a side effect. See the module header.
 */
export const RUNNER_VIPS_CONCURRENCY_DEFAULT = 1

/**
 * The native-allocator variables to add to a runner's environment. Both keys are
 * present or both are absent — see the `VIPS_CONCURRENCY` note in the module
 * header for why one without the other is the dangerous configuration.
 */
export interface RunnerNativeAllocatorEnv {
  readonly MALLOC_ARENA_MAX?: string
  readonly VIPS_CONCURRENCY?: string
}

/**
 * Resolve the native-allocator env for a child runner from the parent's env.
 *
 * Precedence, highest first:
 *   1. `CAMSTACK_RUNNER_NATIVE_ALLOCATOR=off` — kill switch, returns nothing and
 *      restores the glibc/sharp defaults. Recoverable without a rebuild.
 *   2. A value the operator already put in the environment (`MALLOC_ARENA_MAX`,
 *      `VIPS_CONCURRENCY`) — inherited verbatim, never overwritten.
 *   3. The defaults above.
 */
export function runnerNativeAllocatorEnv(
  parentEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): RunnerNativeAllocatorEnv {
  // Linux only. `MALLOC_ARENA_MAX` is a glibc knob and inert elsewhere, but
  // `VIPS_CONCURRENCY` is NOT inert: sharp's concurrency-1 default is its glibc
  // fragmentation defence, so off Linux the pin is a pure throughput cut with no
  // memory to show for it. Measured on this cluster's darwin/arm64 agent,
  // `sharp.concurrency()` is 6 by default where the linux hub returns 1 —
  // exporting the pair everywhere would have cut that node 6x.
  if (platform !== 'linux') return {}
  if (parentEnv['CAMSTACK_RUNNER_NATIVE_ALLOCATOR'] === 'off') return {}
  return {
    MALLOC_ARENA_MAX: parentEnv['MALLOC_ARENA_MAX'] ?? String(RUNNER_MALLOC_ARENA_MAX_DEFAULT),
    VIPS_CONCURRENCY: parentEnv['VIPS_CONCURRENCY'] ?? String(RUNNER_VIPS_CONCURRENCY_DEFAULT),
  }
}

/**
 * The child's environment, with the allocator pair applied or REMOVED.
 *
 * `runnerNativeAllocatorEnv` returns what to add. That was sufficient while the
 * parent had nothing to inherit: omitting a key meant the child never saw it.
 * Once the image entrypoint welds the pair into the container environment — the
 * change that lets an operator drop them from the Unraid template — the child
 * INHERITS them, and a kill switch that only omits is a kill switch that does
 * nothing.
 *
 * So `CAMSTACK_RUNNER_NATIVE_ALLOCATOR=off` DELETES. And only that: the
 * non-linux path returns nothing to add for its own reasons (the pin is a pure
 * throughput cut there — measured `sharp.concurrency()` 6 on the darwin agent
 * against 1 on the linux hub) and must not be read as "remove what the operator
 * chose". Deletion is the switch's job, not absence's.
 */
export function applyRunnerNativeAllocator(
  parentEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...parentEnv }
  if (parentEnv['CAMSTACK_RUNNER_NATIVE_ALLOCATOR'] === 'off') {
    delete next['MALLOC_ARENA_MAX']
    delete next['VIPS_CONCURRENCY']
    return next
  }
  return { ...next, ...runnerNativeAllocatorEnv(parentEnv, platform) }
}
