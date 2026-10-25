import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import PipelineRunnerAddon from '../index.js'
import { Semaphore } from '../semaphore.js'

/**
 * P5 spawn gate — addon-level DEFERRAL LOGGING.
 *
 * White-boxes the addon's private spawn-gate plumbing (same documented
 * type-boundary convention as session-decode-sharing.spec) to prove that a
 * spawn which has to QUEUE for a permit is logged (no silent capping), and one
 * that proceeds immediately is not logged as deferred.
 */
interface GateInternals {
  spawnGate: Semaphore | null
  buildDecodeSpawnAcquire(log: IScopedLogger, label: string): () => Promise<() => void>
}

function asGate(addon: PipelineRunnerAddon): GateInternals {
  return addon as unknown as GateInternals
}

function makeLogger(): {
  logger: IScopedLogger
  info: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
} {
  const info = vi.fn()
  const debug = vi.fn()
  const logger: IScopedLogger = {
    debug,
    info,
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, info, debug }
}

describe('decode spawn gate — deferral logging', () => {
  let addon: PipelineRunnerAddon

  beforeEach(() => {
    addon = new PipelineRunnerAddon()
  })

  it('logs a DEFERRED spawn when the gate is saturated, then logs it proceeding', async () => {
    const gate = new Semaphore(1)
    asGate(addon).spawnGate = gate
    const { logger, info, debug } = makeLogger()
    const acquire = asGate(addon).buildDecodeSpawnAcquire(logger, 'detect')

    // First spawn: a slot is free → acquires immediately, NOT deferred.
    const release1 = await acquire()
    expect(info.mock.calls.some(([msg]) => String(msg).includes('DEFERRED'))).toBe(false)
    expect(debug).toHaveBeenCalled()

    // Second spawn while saturated → the deferral log fires synchronously
    // (before the await inside the acquire).
    const pending = acquire()
    expect(info.mock.calls.some(([msg]) => String(msg).includes('DEFERRED'))).toBe(true)

    // Free the first permit → the deferred spawn proceeds and logs it.
    release1()
    await pending
    expect(info.mock.calls.some(([msg]) => String(msg).includes('now proceeding'))).toBe(true)
  })

  it('returns a no-op acquire (never blocks) when the gate is not initialised', async () => {
    asGate(addon).spawnGate = null
    const { logger } = makeLogger()
    const acquire = asGate(addon).buildDecodeSpawnAcquire(logger, 'motion')
    const release = await acquire()
    expect(typeof release).toBe('function')
    release() // no throw
  })
})
