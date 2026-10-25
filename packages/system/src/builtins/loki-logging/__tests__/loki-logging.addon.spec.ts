/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LokiLoggingAddon } from '../loki-logging.addon.js'
import { RETIREMENT_MARKER_KEY } from '../retire-enabled-flag.js'

/**
 * Loki has ONE enable: the per-destination `log-destination` capability toggle
 * (D777). A stored `enabled: false` from before that is carried over to the
 * toggle ONCE. The toggle refuses a provider that is not registered yet, and
 * the provider is registered only AFTER `onInitialize` returns — so a carry-over
 * attempted inside `onInitialize` can never succeed, and it used to leave Loki
 * shipping for an operator who had switched it off.
 */

function makeLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

function makeCtx(initial: Record<string, unknown>) {
  let store: Record<string, unknown> = { ...initial }
  // Mirrors `writeCollectionToggle`: an unregistered provider is refused.
  let registered = false
  const setCapabilityProviderEnabled = vi.fn(async () => {
    if (!registered)
      throw new Error('Provider "loki-logging" is not registered for "log-destination"')
    return { success: true as const }
  })
  const settings = {
    readAddonStore: vi.fn(async () => ({ ...store })),
    readAddonStoreResult: vi.fn(async () => ({ kind: 'value' as const, value: { ...store } })),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      // The real views rewrite the merged blob whole; `undefined` is not persisted.
      store = JSON.parse(JSON.stringify({ ...store, ...patch })) as Record<string, unknown>
    }),
    readDeviceStore: vi.fn(async () => ({})),
    writeDeviceStore: vi.fn(async () => undefined),
    getSection: vi.fn(async () => ({})),
    setSection: vi.fn(async () => undefined),
  }
  const ctx = {
    id: 'loki-logging',
    logger: makeLogger(),
    settings,
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel: { localNodeId: 'hub' },
    api: { addons: { setCapabilityProviderEnabled: { mutate: setCapabilityProviderEnabled } } },
  } as unknown as AddonContext
  return {
    ctx,
    setCapabilityProviderEnabled,
    getStore: () => store,
    markRegistered: () => {
      registered = true
    },
  }
}

/** Boot the addon the way the kernel does: register the providers only after initialize returns. */
async function boot(initial: Record<string, unknown>) {
  const addon = new LokiLoggingAddon()
  const harness = makeCtx(initial)
  await addon.initialize(harness.ctx)
  harness.markRegistered()
  return { addon, ...harness }
}

describe('LokiLoggingAddon — one enable (D777)', () => {
  const addons: LokiLoggingAddon[] = []
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(async () => {
    for (const a of addons.splice(0)) await a.shutdown()
    vi.useRealTimers()
  })

  it('stored enabled:false → disabled at the log-destination toggle once the provider is registered', async () => {
    const { addon, setCapabilityProviderEnabled, getStore } = await boot({
      enabled: false,
      url: 'http://loki:3100',
    })
    addons.push(addon)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(getStore()[RETIREMENT_MARKER_KEY]).toBe(true))
    expect(setCapabilityProviderEnabled).toHaveBeenLastCalledWith({
      capName: 'log-destination',
      addonId: 'loki-logging',
      enabled: false,
    })
    expect('enabled' in getStore()).toBe(false)
  })

  it('stored enabled:true → leaves the toggle alone, still writes the marker', async () => {
    const { addon, setCapabilityProviderEnabled, getStore } = await boot({ enabled: true })
    addons.push(addon)
    await vi.waitFor(() => expect(getStore()[RETIREMENT_MARKER_KEY]).toBe(true))
    expect(setCapabilityProviderEnabled).not.toHaveBeenCalled()
    expect('enabled' in getStore()).toBe(false)
  })

  it('never written → leaves the toggle alone', async () => {
    const { addon, setCapabilityProviderEnabled, getStore } = await boot({})
    addons.push(addon)
    await vi.waitFor(() => expect(getStore()[RETIREMENT_MARKER_KEY]).toBe(true))
    expect(setCapabilityProviderEnabled).not.toHaveBeenCalled()
  })

  it('already migrated → never overrides a later operator choice, even with a stale enabled:false', async () => {
    const { addon, setCapabilityProviderEnabled } = await boot({
      [RETIREMENT_MARKER_KEY]: true,
      enabled: false,
    })
    addons.push(addon)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(setCapabilityProviderEnabled).not.toHaveBeenCalled()
  })

  it('declares no `enabled` field in its settings schema', async () => {
    const { addon } = await boot({ [RETIREMENT_MARKER_KEY]: true })
    addons.push(addon)
    const schema = await addon.getGlobalSettings()
    const keys = (schema?.sections ?? []).flatMap((s) =>
      s.fields.map((f) => ('key' in f ? f.key : null)),
    )
    expect(keys).not.toContain('enabled')
    expect(keys).toContain('url')
  })
})
