/**
 * Settings-API migration (P3c) — the Homematic provider's legacy-config
 * migration read in `onInitialize` must go through the sanctioned
 * projected-store seam (`resolveGlobalStore`) instead of raw
 * `ctx.settings.readAddonStore()`. The read is intentionally RAW-view:
 * the legacy `connection` key is not part of `DEFAULTS`, so it is never
 * visible on `this.config` — behavior must stay identical.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { AddonContext, IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { HomematicProviderAddon } from '../addon.js'
import { makeHmRecords } from './fake-records.js'

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
}

async function makeCtx(seed: Record<string, unknown> = {}): Promise<FakeHarness> {
  const { records } = await makeHmRecords()
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

  const ctx = {
    id: 'provider-homematic',
    logger: makeSilentLogger(),
    eventBus: bus,
    addonConfig: {},
    kernel: { localNodeId: 'hub' },
    api: {
      integrations: {
        list: {
          query: async () => {
            throw new Error('integrations cap unavailable in this spec')
          },
        },
      },
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
    records,
  } as unknown as AddonContext

  return { ctx, store }
}

describe('HomematicProviderAddon — settings accessor migration', () => {
  let addon: HomematicProviderAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('empty store boots with no brokers and writes nothing (equivalence)', async () => {
    const { ctx, store } = await makeCtx()
    addon = new HomematicProviderAddon()
    await addon.initialize(ctx)

    // No legacy `connection` and no `brokers` ⇒ nothing to migrate,
    // nothing persisted.
    expect(store['brokers']).toBeUndefined()
    expect(store['connection']).toBeUndefined()
  })

  it('already-migrated store is left untouched (equivalence)', async () => {
    const { ctx, store } = await makeCtx({ brokers: [] })
    addon = new HomematicProviderAddon()
    await addon.initialize(ctx)

    expect(store['brokers']).toEqual([])
  })

  it('onInitialize reads the raw legacy view via the sanctioned seam, not readAddonStore (structural)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../addon.ts'), 'utf8')
    const start = source.indexOf('protected override async onInitialize(')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\n  }', source.indexOf('return [', start))
    const body = source.slice(start, end)
    expect(body).not.toMatch(/readAddonStore/)
    expect(body).toMatch(/resolveGlobalStore/)
  })
})
