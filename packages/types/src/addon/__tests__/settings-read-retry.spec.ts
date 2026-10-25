import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseAddon, classifyStoreError } from '../base-addon.js'
import { fakeAddonContext } from './fake-addon-context.js'
import type { AddonContext } from '../../interfaces/addon.js'

/**
 * Since D870 a runner's settings read THROWS when the store cannot be asked.
 * A hub restart under a booting agent runner must therefore be ridden out by a
 * bounded retry, or `initialize()` fails, the runner respawns, and the crash
 * supervisor ends it terminally.
 */
class Probe extends BaseAddon<{ fps: number }> {
  constructor() {
    super({ fps: 5 })
  }
  protected async onInitialize() {
    return []
  }
}

function contextWith(read: () => Promise<Record<string, unknown>>): AddonContext {
  const base = fakeAddonContext({ id: 'probe' })
  return {
    ...base,
    settings: { ...base.settings!, readAddonStore: read },
  }
}

describe('a settings read that cannot reach the hub at boot', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('HUB RESTARTS while the runner boots: the runner comes up with the stored settings', async () => {
    let calls = 0
    const ctx = contextWith(async () => {
      calls += 1
      if (calls <= 3) {
        throw new Error('[brokerTransportLink] discovery deadline exceeded — call will fast-fail')
      }
      return { fps: 12 }
    })
    const addon = new Probe()
    const started = addon.initialize(ctx)
    await vi.advanceTimersByTimeAsync(5_000)
    await started
    expect(calls).toBe(4)
    expect(addon.config.fps).toBe(12)
    await addon.shutdown()
  })

  it('a hub that stays away fails the start after a bounded wait - it never runs on defaults', async () => {
    let calls = 0
    const ctx = contextWith(async () => {
      calls += 1
      throw new Error('parent could not route child unowned cap call')
    })
    const addon = new Probe()
    const started = addon.initialize(ctx).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const err = await started
    expect(err).toBeInstanceOf(Error)
    expect(calls).toBeGreaterThan(5)
    expect(calls).toBeLessThan(20)
  })

  it('a real bug is not retried', async () => {
    let calls = 0
    const ctx = contextWith(async () => {
      calls += 1
      throw new Error('TypeError: x is not a function')
    })
    await expect(new Probe().initialize(ctx)).rejects.toThrow('TypeError')
    expect(calls).toBe(1)
  })

  it('classifies only EXPLICIT signals', () => {
    expect(classifyStoreError(new Error('discovery deadline exceeded'))).toBe('transport')
    expect(classifyStoreError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(
      'transport',
    )
    expect(
      classifyStoreError(Object.assign(new Error('x'), { data: { code: 'SERVICE_UNAVAILABLE' } })),
    ).toBe('transport')
    expect(classifyStoreError(new Error('SqliteSettingsBackend not initialized'))).toBe('restart')
    // substrings of arbitrary messages are not evidence
    expect(classifyStoreError(new Error('timed out waiting for the operator'))).toBe('permanent')
    expect(classifyStoreError(new Error('the branch is unreachable code'))).toBe('permanent')
    expect(classifyStoreError(new Error('boom'))).toBe('permanent')
  })

  it('"settings store not wired" is a wiring bug: it fails fast, no retry', async () => {
    let calls = 0
    const ctx = contextWith(async () => {
      calls += 1
      throw new Error('settings store not wired')
    })
    await expect(new Probe().initialize(ctx)).rejects.toThrow('not wired')
    expect(calls).toBe(1)
  })
})
