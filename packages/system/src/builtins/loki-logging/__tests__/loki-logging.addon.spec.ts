/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LokiLoggingAddon } from '../loki-logging.addon.js'

/**
 * Loki has ONE enable: the per-destination toggle (D777). The retirement of the legacy `enabled`
 * key is a ledger migration (`migrations/__tests__/retired-enabled-flag.sqlite.spec.ts`).
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

  it('declares no connection setting (D985): the connection form belongs to the record', async () => {
    const { addon } = await boot({})
    addons.push(addon)
    const schema = await addon.getIntegrationFormSchema({ integrationId: null, mode: 'standalone' })
    const keys = (schema?.sections ?? []).flatMap((s) =>
      s.fields.map((f) => ('key' in f ? f.key : null)),
    )
    expect(keys).toEqual([])
  })
})
