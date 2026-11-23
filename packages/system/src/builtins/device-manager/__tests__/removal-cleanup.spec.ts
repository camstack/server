/**
 * `createRemovalCleanup` with `concurrent: true` — the hook fan-out (D865).
 *
 * The implementers of `device-removal-hook` are independent of one another, so
 * a delete must not pay for them one after the other: a slow implementer is
 * what made deleting a camera take seconds. The rule that does not change:
 * every step runs, one that throws neither stops nor delays the rest, and is
 * logged and retried on its own.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { createRemovalCleanup, type RemovalStep } from '../removal-cleanup.js'

function logger(): IScopedLogger {
  const fake: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fake,
    withTags: () => fake,
  }
  return fake
}

/** Yield to the microtask queue a few times — enough for every started step to have started. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('a concurrent removal cleanup', () => {
  it('starts every step before any of them has finished', async () => {
    const cleanup = createRemovalCleanup({
      logger: logger(),
      concurrent: true,
    })
    let running = 0
    let peak = 0
    let openGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const step = (store: string): RemovalStep => ({
      store,
      run: async () => {
        running += 1
        peak = Math.max(peak, running)
        await gate
        running -= 1
        return 1
      },
    })
    const done = cleanup.run(7, [step('hook:a'), step('hook:b'), step('hook:c')])
    await settle()
    expect(peak).toBe(3)
    openGate()
    const report = await done
    expect(report.counts).toEqual({ 'hook:a': 1, 'hook:b': 1, 'hook:c': 1 })
    expect(report.failed).toEqual([])
    cleanup.dispose()
  })

  it('a step that throws neither skips nor delays the others, and is reported failed with the deviceId tag', async () => {
    const log = logger()
    const cleanup = createRemovalCleanup({
      logger: log,
      concurrent: true,
      retryDelaysMs: [],
    })
    const ran: string[] = []
    const report = await cleanup.run(9, [
      {
        store: 'hook:broken',
        run: async () => {
          throw new Error('implementer unreachable')
        },
      },
      {
        store: 'hook:ok',
        run: async () => {
          ran.push('ok')
          return 4
        },
      },
    ])
    expect(ran).toEqual(['ok'])
    expect(report.counts).toEqual({ 'hook:ok': 4 })
    expect(report.failed).toEqual(['hook:broken'])
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('incomplete'),
      expect.objectContaining({ tags: { deviceId: 9 } }),
    )
    cleanup.dispose()
  })

  it('a sequential cleanup (the default) still runs one step at a time', async () => {
    const cleanup = createRemovalCleanup({ logger: logger() })
    let running = 0
    let peak = 0
    const step = (store: string): RemovalStep => ({
      store,
      run: async () => {
        running += 1
        peak = Math.max(peak, running)
        await settle()
        running -= 1
        return 1
      },
    })
    await cleanup.run(1, [step('a'), step('b')])
    expect(peak).toBe(1)
    cleanup.dispose()
  })
})
