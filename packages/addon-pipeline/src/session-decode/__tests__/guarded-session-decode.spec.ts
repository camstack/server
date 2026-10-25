import { describe, it, expect, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { startGuardedSessionDecode } from '../guarded-session-decode.js'

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

describe('startGuardedSessionDecode', () => {
  it('abort during acquire releases and never starts the pump', async () => {
    const logger = makeLogger()
    const release = vi.fn().mockResolvedValue(undefined)
    let resolveAcquire!: (v: { source: 'S'; release: typeof release } | null) => void
    const acquire = () =>
      new Promise<{ source: 'S'; release: typeof release } | null>((r) => {
        resolveAcquire = r
      })
    const startPump = vi.fn(() => vi.fn())

    const teardown = startGuardedSessionDecode({ acquire, startPump, logger })
    teardown() // detach BEFORE acquire resolves
    resolveAcquire({ source: 'S', release })
    await Promise.resolve()
    await Promise.resolve()

    expect(startPump).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('normal teardown stops the pump then releases', async () => {
    const logger = makeLogger()
    const release = vi.fn().mockResolvedValue(undefined)
    const stopPump = vi.fn()
    const startPump = vi.fn(() => stopPump)
    const acquire = async () => ({ source: 'S' as const, release })

    const teardown = startGuardedSessionDecode({ acquire, startPump, logger })
    await Promise.resolve()
    await Promise.resolve() // let acquire+start run
    teardown()

    expect(stopPump).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('acquire returns null → teardown is a no-op, no throw', async () => {
    const logger = makeLogger()
    const startPump = vi.fn(() => vi.fn())
    const acquire = async () => null

    const teardown = startGuardedSessionDecode({ acquire, startPump, logger })
    await Promise.resolve()
    await Promise.resolve()

    expect(() => teardown()).not.toThrow()
    expect(startPump).not.toHaveBeenCalled()
  })
})
