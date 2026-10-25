/**
 * The boot runner plan overlaps, and overlapping it does not corrupt the one
 * process-global resource it touches.
 *
 * See `runner-spawn-fanout.ts` for the measurement and the reasoning; these are
 * the gates. Each fails when its fix is removed: revert `spawnPlanConcurrently`
 * to a `for … await` and the peak-overlap assertion drops to 1; drop the keyed
 * serializer and same-key work interleaves.
 */
import { describe, expect, it } from 'vitest'
import {
  createKeyedSerializer,
  RUNNER_SPAWN_CONCURRENCY,
  spawnPlanConcurrently,
} from '../runner-spawn-fanout.js'

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('spawnPlanConcurrently — the plan fans out', () => {
  it('overlaps runners instead of summing them', async () => {
    const plan = new Map(Array.from({ length: 20 }, (_, i) => [`runner-${i}`, i]))
    let inFlight = 0
    let peak = 0

    await spawnPlanConcurrently(plan, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await tick(5)
      inFlight--
    })

    expect(peak).toBeGreaterThan(1)
  })

  it('never exceeds the bound — the hub event loop still has to answer the children', async () => {
    const plan = new Map(Array.from({ length: 40 }, (_, i) => [`runner-${i}`, i]))
    let inFlight = 0
    let peak = 0

    await spawnPlanConcurrently(plan, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await tick(2)
      inFlight--
    })

    expect(peak).toBe(RUNNER_SPAWN_CONCURRENCY)
  })

  it('spawns every entry exactly once, and awaits them all', async () => {
    const plan = new Map([
      ['a', ['a1']],
      ['b', ['b1', 'b2']],
      ['c', ['c1']],
    ])
    const seen: string[] = []

    await spawnPlanConcurrently(plan, async (runnerId, addons) => {
      await tick(1)
      seen.push(`${runnerId}:${addons.length}`)
    })

    expect(seen.sort()).toEqual(['a:1', 'b:2', 'c:1'])
  })

  it('one slow runner does not delay the rest', async () => {
    const plan = new Map([
      ['slow', 60],
      ['fast-1', 1],
      ['fast-2', 1],
    ])
    const finished: string[] = []

    await spawnPlanConcurrently(plan, async (runnerId, delay) => {
      await tick(delay)
      finished.push(runnerId)
    })

    // Serially `slow` was first in the map and everything queued behind it.
    expect(finished[finished.length - 1]).toBe('slow')
  })

  it('an empty plan is a no-op', async () => {
    let calls = 0
    await spawnPlanConcurrently(new Map<string, number>(), async () => {
      calls++
    })
    expect(calls).toBe(0)
  })
})

describe('createKeyedSerializer — the require.cache purge stays purge-then-import', () => {
  it('work sharing a key never overlaps', async () => {
    const serializer = createKeyedSerializer()
    let inFlight = 0
    let peak = 0
    const load = async (): Promise<void> => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await tick(5)
      inFlight--
    }

    // The four `@camstack/addon-remote-storage` addons (sftp, s3, webdav,
    // smb): distinct runners, one shared `dist/` directory, all in the same
    // plan.
    await Promise.all([
      serializer.run('/pkg/remote-storage/dist', load),
      serializer.run('/pkg/remote-storage/dist', load),
      serializer.run('/pkg/remote-storage/dist', load),
      serializer.run('/pkg/remote-storage/dist', load),
    ])

    expect(peak).toBe(1)
  })

  it('work under different keys still overlaps', async () => {
    const serializer = createKeyedSerializer()
    let inFlight = 0
    let peak = 0
    const load = async (): Promise<void> => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await tick(5)
      inFlight--
    }

    await Promise.all([
      serializer.run('/pkg/a/dist', load),
      serializer.run('/pkg/b/dist', load),
      serializer.run('/pkg/c/dist', load),
    ])

    expect(peak).toBe(3)
  })

  it('a rejecting predecessor neither cancels nor poisons its successors', async () => {
    const serializer = createKeyedSerializer()
    const order: string[] = []

    const first = serializer.run('/pkg/a/dist', async () => {
      await tick(2)
      order.push('first')
      throw new Error('bundle is not there')
    })
    const second = serializer.run('/pkg/a/dist', async () => {
      order.push('second')
      return 'ok'
    })

    await expect(first).rejects.toThrow('bundle is not there')
    await expect(second).resolves.toBe('ok')
    expect(order).toEqual(['first', 'second'])
  })

  it('returns the work result to its own caller', async () => {
    const serializer = createKeyedSerializer()
    await expect(serializer.run('/k', async () => 42)).resolves.toBe(42)
  })
})
