import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { BaseAddon } from '../base-addon.js'

// Minimal concrete addon exposing the protected helpers for the test.
class TestAddon extends BaseAddon {
  protected async onInitialize() {
    return []
  }
  pubState<T>(key: string, schema: z.ZodType<T>, fallback: T) {
    return this.state(key, schema, fallback)
  }
  pubDeviceState<T>(id: number, key: string, schema: z.ZodType<T>, fallback: T) {
    return this.deviceState(id, key, schema, fallback)
  }
}

function ctxWith(
  addonStore: Record<string, unknown>,
  deviceStores: Record<number, Record<string, unknown>>,
) {
  return {
    id: 'test-addon',
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => ({}),
      withTags: () => ({}),
    },
    kernel: { localNodeId: 'hub' },
    settings: {
      readAddonStore: async () => ({ ...addonStore }),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        Object.assign(addonStore, patch)
      },
      readDeviceStore: async (id: number) => ({ ...deviceStores[id] }),
      writeDeviceStore: async (id: number, patch: Record<string, unknown>) => {
        deviceStores[id] = { ...deviceStores[id], ...patch }
      },
    },
  } as unknown as Parameters<BaseAddon['initialize']>[0]
}

const S = z.object({
  derived: z.record(z.string(), z.object({ src: z.string() })).optional(),
  n: z.number().optional(),
})

describe('BaseAddon durable-state helpers', () => {
  it('this.state round-trips the whole object through the addon store', async () => {
    const addonStore: Record<string, unknown> = {}
    const a = new TestAddon({})
    await a.initialize(ctxWith(addonStore, {}))
    const h = a.pubState('blob', S, {})
    await h.set({ derived: { web720: { src: 'native:main' } }, n: 3 })
    // A fresh handle (simulating restart) reads it back intact.
    const h2 = a.pubState('blob', S, {})
    expect(await h2.get()).toEqual({ derived: { web720: { src: 'native:main' } }, n: 3 })
    expect(addonStore['blob']).toEqual({ derived: { web720: { src: 'native:main' } }, n: 3 })
  })

  it('this.deviceState round-trips through the per-device store', async () => {
    const deviceStores: Record<number, Record<string, unknown>> = {}
    const a = new TestAddon({})
    await a.initialize(ctxWith({}, deviceStores))
    const h = a.pubDeviceState(42, 'blob', S, {})
    await h.set({ n: 9 })
    expect(deviceStores[42]).toEqual({ blob: { n: 9 } })
  })
})

describe('BaseAddon settings-store readiness', () => {
  class ReadyAddon extends TestAddon {
    get storeReady(): boolean {
      return this.settingsStoreReady
    }
  }

  it('marks the store ready after a successful read, including an empty one', async () => {
    const a = new ReadyAddon({})
    await a.initialize(ctxWith({}, {}))
    expect(a.storeReady).toBe(true)
  })

  it('does not treat a store that never answered as empty — defaults are not stored config', async () => {
    const a = new ReadyAddon({ mode: 'quick' })
    const ctx = ctxWith({}, {})
    const settings = ctx.settings
    if (settings === undefined) throw new Error('the fixture context carries settings')
    settings.readAddonStore = async () => {
      throw new Error('provider not available')
    }
    await a.initialize(ctx)
    expect(a.storeReady).toBe(false)
  })
})
