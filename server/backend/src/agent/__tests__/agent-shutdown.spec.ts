/**
 * The agent's graceful shutdown is bounded, re-entry guarded and says why it started.
 * A SIGTERM once hung 9.5 minutes on an addon's `shutdown()`, leaving the node alive but deregistered.
 */
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentShutdown, type ShutdownStep } from '../agent-shutdown'

interface Line {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
}

function recorder(): { readonly logger: IScopedLogger; readonly lines: Line[] } {
  const lines: Line[] = []
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
    error: (message) => lines.push({ level: 'error', message }),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

const never = (): Promise<void> => new Promise<void>(() => undefined)

describe('createAgentShutdown', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs every step in order, logs trigger and elapsed, exits 0', async () => {
    const { logger, lines } = recorder()
    const order: string[] = []
    const exit = vi.fn()
    const steps: ShutdownStep[] = [
      { name: 'addons', run: async () => void order.push('addons') },
      { name: 'broker', run: async () => void order.push('broker') },
    ]
    const shutdown = createAgentShutdown({ steps, logger, exit })
    await shutdown('SIGTERM')
    expect(order).toEqual(['addons', 'broker'])
    expect(exit).toHaveBeenCalledWith(0)
    expect(lines[0]?.message).toContain('SIGTERM')
    expect(lines.some((l) => /addons.*\d+ ?ms/.test(l.message))).toBe(true)
  })

  it('bounds a hung step and still runs the rest', async () => {
    const { logger, lines } = recorder()
    const exit = vi.fn()
    const ran: string[] = []
    const steps: ShutdownStep[] = [
      { name: 'addons', run: never },
      { name: 'broker', run: async () => void ran.push('broker') },
    ]
    const shutdown = createAgentShutdown({ steps, logger, exit, stepTimeoutMs: 3_000 })
    const done = shutdown('SIGTERM')
    await vi.advanceTimersByTimeAsync(3_001)
    await done
    expect(ran).toEqual(['broker'])
    expect(
      lines.some(
        (l) =>
          l.level === 'warn' && l.message.includes('addons') && l.message.includes('timed out'),
      ),
    ).toBe(true)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('a failing step is logged and does not stop the pass', async () => {
    const { logger, lines } = recorder()
    const exit = vi.fn()
    const steps: ShutdownStep[] = [
      { name: 'mdns', run: async () => Promise.reject(new Error('boom')) },
      { name: 'broker', run: async () => undefined },
    ]
    await createAgentShutdown({ steps, logger, exit })('SIGINT')
    expect(lines.some((l) => l.message.includes('mdns') && l.message.includes('boom'))).toBe(true)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('a hard deadline ends in a non-zero exit even when the steps never end', async () => {
    const { logger, lines } = recorder()
    const exit = vi.fn()
    const steps: ShutdownStep[] = [{ name: 'addons', run: never }]
    // step timeout longer than the deadline: only the deadline can save us
    const shutdown = createAgentShutdown({
      steps,
      logger,
      exit,
      stepTimeoutMs: 60_000,
      deadlineMs: 15_000,
    })
    void shutdown('SIGTERM')
    await vi.advanceTimersByTimeAsync(15_001)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(lines.some((l) => l.level === 'error' && l.message.includes('deadline'))).toBe(true)
  })

  it('a second signal does not start a second pass but forces exit', async () => {
    const { logger, lines } = recorder()
    const exit = vi.fn()
    let runs = 0
    const steps: ShutdownStep[] = [
      {
        name: 'addons',
        run: () => {
          runs += 1
          return never()
        },
      },
    ]
    const shutdown = createAgentShutdown({ steps, logger, exit })
    void shutdown('SIGTERM')
    await vi.advanceTimersByTimeAsync(10)
    await shutdown('SIGINT')
    expect(runs).toBe(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(lines.some((l) => l.message.includes('SIGINT') && l.message.includes('already'))).toBe(
      true,
    )
  })
})
