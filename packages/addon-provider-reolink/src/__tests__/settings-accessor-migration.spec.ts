/**
 * Settings-API migration (P3c) — the Reolink provider must access the
 * addon store through the high-level BaseAddon settings API:
 *
 *  - email-push settings reads (getGlobalSettings hydration + the
 *    server's `readStore` dep) via the sanctioned projected-store seam,
 *  - the bootstrapped SMTP AUTH credentials via `this.state()` durable
 *    handles (SAME keys `emailPushAuthUsername`/`emailPushAuthPassword`,
 *    same string shape),
 *  - settings writes via the base `updateGlobalSettings` (same bare
 *    keys, plus the sanctioned `AddonUpdated` lifecycle emission and the
 *    `onConfigChanged` restart the old override triggered manually).
 *
 * Equivalence tests encode the CURRENT behavior and must pass before
 * AND after the accessor swap.
 */

import type { AddonContext, IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReolinkProviderAddon } from '../addon.js'

function makeSilentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface FakeHarness {
  readonly ctx: AddonContext
  readonly store: Record<string, unknown>
  readonly captured: SystemEvent[]
  readonly broker: {
    list: { query: ReturnType<typeof vi.fn> }
    add: { mutate: ReturnType<typeof vi.fn> }
  }
}

function makeCtx(seed: Record<string, unknown> = {}): FakeHarness {
  const store: Record<string, unknown> = { ...seed }
  const captured: SystemEvent[] = []
  const handlers = new Set<(e: SystemEvent) => void>()
  const bus = {
    emit(event: SystemEvent) {
      captured.push(event)
      for (const h of handlers) h(event)
    },
    subscribe(_filter: unknown, handler: (e: SystemEvent) => void) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  } as unknown as IEventBus

  const broker = {
    list: { query: vi.fn(async () => []) },
    add: { mutate: vi.fn() },
  }
  const ctx = {
    id: 'provider-reolink',
    logger: makeSilentLogger(),
    eventBus: bus,
    addonConfig: {},
    kernel: { localNodeId: 'hub' },
    // The records door of a hub-only addon: the integration kind is declared, nothing is stored.
    records: { declare: async () => undefined, kind: () => ({}), owner: 'provider-reolink' },
    api: {
      migrations: {
        declareOwner: { mutate: vi.fn(async () => ({ bootId: 'b', snapshot: 'none', steps: [] })) },
        startMigration: { mutate: vi.fn() },
        finishMigration: { mutate: vi.fn() },
      },
      broker,
    },
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp',
    settings: {
      async readAddonStore() {
        return { ...store }
      },
      async writeAddonStore(patch: Record<string, unknown>) {
        Object.assign(store, patch)
      },
      async readDeviceStore() {
        return {}
      },
      async writeDeviceStore() {
        /* no-op */
      },
    },
  } as unknown as AddonContext

  return { ctx, store, captured, broker }
}

interface FieldWithValue {
  readonly key?: string
  readonly value?: unknown
  readonly fields?: readonly FieldWithValue[]
}

function collectFields(
  sections: ReadonlyArray<{ fields?: readonly FieldWithValue[] }>,
): FieldWithValue[] {
  const out: FieldWithValue[] = []
  const walk = (fields: readonly FieldWithValue[] | undefined): void => {
    for (const f of fields ?? []) {
      out.push(f)
      if (f.fields) walk(f.fields)
    }
  }
  for (const s of sections) walk(s.fields)
  return out
}

describe('ReolinkProviderAddon — settings accessor migration', () => {
  let addon: ReolinkProviderAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('a bare boot never creates the camera mailbox (it is created on first need)', async () => {
    const { ctx, broker } = makeCtx({})
    addon = new ReolinkProviderAddon()
    await addon.initialize(ctx)
    await new Promise((r) => setTimeout(r, 50))
    expect(broker.list.query).not.toHaveBeenCalled()
    expect(broker.add.mutate).not.toHaveBeenCalled()
  })

  it('getGlobalSettings hydrates the seeded store values (equivalence)', async () => {
    const { ctx } = makeCtx({ clipCatalogRefreshMinutes: 17 })
    addon = new ReolinkProviderAddon()
    await addon.initialize(ctx)

    const hydrated = await addon.getGlobalSettings()
    // `BaseAddon.getGlobalSettings` is nullable ("cannot serve settings right
    // now"). Reolink used to override it with a non-null return; it now
    // declares `globalSettingsSchema()` and inherits the base getter, so the
    // null case is part of the contract and the test states it rather than
    // leaning on a narrower override signature.
    expect(hydrated, 'getGlobalSettings returned null').not.toBeNull()
    const fields = collectFields(hydrated?.sections ?? [])
    const minutes = fields.find((f) => f.key === 'clipCatalogRefreshMinutes')
    expect(minutes?.value).toBe(17)
  })

  it('updateGlobalSettings persists bare keys AND emits AddonUpdated (base settings API)', async () => {
    const { ctx, store, captured } = makeCtx({})
    addon = new ReolinkProviderAddon()
    await addon.initialize(ctx)

    await addon.updateGlobalSettings({ clipCatalogRefreshMinutes: 33 })

    expect(store['clipCatalogRefreshMinutes']).toBe(33)
    expect(Object.keys(store).some((k) => k.includes('@'))).toBe(false)
    const updated = captured.filter((e) => e.category === EventCategory.AddonUpdated)
    expect(updated.length).toBeGreaterThan(0)
    expect(updated[0]!.data).toMatchObject({ level: 'global' })
  })
})
