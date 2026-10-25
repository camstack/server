/**
 * The forked runner's NATIVE allocator env — the half of a runner's memory that
 * no V8 flag can reach.
 *
 * Measured on the live hub 2026-08-25: `hub/pipeline-analytics` sat at 2663MB RSS
 * against an 81MB V8 heap. Its `[mem] reclaim` line reads
 * `stranded=2552MB … arrayBuffers=81MB→29MB` — 96% of that process is native,
 * and the `arrayBuffers` FLOOR returns to ~1MB every cycle, so it is not a leak:
 * it is glibc holding freed pages in per-thread arenas.
 */
import { describe, expect, it } from 'vitest'
import {
  RUNNER_MALLOC_ARENA_MAX_DEFAULT,
  RUNNER_VIPS_CONCURRENCY_DEFAULT,
  runnerNativeAllocatorEnv,
} from '../../moleculer/runner-native-allocator.js'

describe('runnerNativeAllocatorEnv', () => {
  it('bounds glibc arenas by default — a forked runner never inherits the 8×ncpu default', () => {
    const env = runnerNativeAllocatorEnv({}, 'linux')
    expect(env.MALLOC_ARENA_MAX).toBe(String(RUNNER_MALLOC_ARENA_MAX_DEFAULT))
  })

  /**
   * Both variables are glibc-shaped and BOTH are wrong off Linux.
   *
   * `MALLOC_ARENA_MAX` is a glibc knob: on macOS it is inert. `VIPS_CONCURRENCY`
   * is NOT inert, and that is the trap — sharp's concurrency-1 default is its
   * glibc fragmentation defence and does not apply elsewhere. Measured on the
   * cluster's darwin/arm64 agent: `sharp.concurrency()` is 6 by default, where
   * the same call in the linux hub container returns 1.
   *
   * So exporting the pair unconditionally would have cut that agent's libvips
   * concurrency from 6 to 1 — a real throughput regression on the one node where
   * the memory lever buys precisely nothing.
   */
  it.each([
    ['darwin'],
    ['win32'],
  ])('sets NOTHING on %s — MALLOC_ARENA_MAX is inert there and the concurrency pin is a pure regression', (platform) => {
    const env = runnerNativeAllocatorEnv({}, platform as NodeJS.Platform)
    expect(env.MALLOC_ARENA_MAX).toBeUndefined()
    expect(env.VIPS_CONCURRENCY).toBeUndefined()
  })

  /**
   * THE load-bearing case. `sharp` reads `MALLOC_ARENA_MAX` in its NATIVE
   * binding: unset on glibc it pins libvips concurrency to 1 (its own
   * fragmentation defence), and the moment the variable appears it restores
   * concurrency to `availableParallelism()`.
   *
   * Measured in the live container, same binary, same corpus:
   *   MALLOC_ARENA_MAX unset               → sharp.concurrency() === 1
   *   MALLOC_ARENA_MAX=2                   → sharp.concurrency() === 20
   *   MALLOC_ARENA_MAX=2 VIPS_CONCURRENCY=1 → sharp.concurrency() === 1
   *
   * So shipping the arena bound ALONE silently ships a 1→20 libvips threading
   * change to the busiest addon on a host already at ~75% CPU. The allocator
   * lever must change the allocator and nothing else; the threading model is a
   * separate decision with a separate review.
   */
  it('pins libvips concurrency alongside it — the arena bound must not smuggle in a 20x threading change', () => {
    const env = runnerNativeAllocatorEnv({}, 'linux')
    expect(env.VIPS_CONCURRENCY).toBe(String(RUNNER_VIPS_CONCURRENCY_DEFAULT))
    // Never one without the other: `MALLOC_ARENA_MAX` set with `VIPS_CONCURRENCY`
    // absent is exactly the configuration that flips sharp to 20 threads.
    expect(env.MALLOC_ARENA_MAX === undefined).toBe(env.VIPS_CONCURRENCY === undefined)
  })

  it('has a kill switch that needs no rebuild — `off` restores the glibc/sharp defaults', () => {
    const env = runnerNativeAllocatorEnv({ CAMSTACK_RUNNER_NATIVE_ALLOCATOR: 'off' }, 'linux')
    expect(env.MALLOC_ARENA_MAX).toBeUndefined()
    expect(env.VIPS_CONCURRENCY).toBeUndefined()
  })

  it('an operator value already in the environment WINS — we never overwrite a deliberate choice', () => {
    const env = runnerNativeAllocatorEnv({ MALLOC_ARENA_MAX: '8', VIPS_CONCURRENCY: '4' }, 'linux')
    expect(env.MALLOC_ARENA_MAX).toBe('8')
    expect(env.VIPS_CONCURRENCY).toBe('4')
  })

  it('an operator who sets only the arena count still gets the concurrency pin', () => {
    const env = runnerNativeAllocatorEnv({ MALLOC_ARENA_MAX: '8' }, 'linux')
    expect(env.MALLOC_ARENA_MAX).toBe('8')
    expect(env.VIPS_CONCURRENCY).toBe(String(RUNNER_VIPS_CONCURRENCY_DEFAULT))
  })

  it('ignores the retired CamStack arena override', () => {
    const env = runnerNativeAllocatorEnv({ CAMSTACK_RUNNER_MALLOC_ARENA_MAX: '4' }, 'linux')
    expect(env.MALLOC_ARENA_MAX).toBe(String(RUNNER_MALLOC_ARENA_MAX_DEFAULT))
  })
})
