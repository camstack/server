/**
 * Settings-API migration (P3c) — the ONVIF provider must access the
 * addon store through the high-level BaseAddon settings API:
 *
 *  - `getGlobalSettings` hydration + `_getAddonConfig` reads via the
 *    sanctioned projected-store seam (no raw `readAddonStore`),
 *  - settings writes via the base `updateGlobalSettings` (same bare
 *    keys, plus the sanctioned `AddonUpdated` lifecycle emission).
 *
 * Equivalence tests encode the CURRENT behavior and must pass before
 * AND after the accessor swap.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddonContext, IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { OnvifProviderAddon } from '../addon.js'

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

  const ctx = {
    id: 'provider-onvif',
    logger: makeSilentLogger(),
    eventBus: bus,
    addonConfig: {},
    kernel: { localNodeId: 'hub' },
    api: undefined,
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

  return { ctx, store, captured }
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
  for (const s of sections) for (const f of s.fields ?? []) out.push(f)
  return out
}

describe('OnvifProviderAddon — settings accessor migration', () => {
  let addon: OnvifProviderAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('getGlobalSettings hydrates the seeded store values (equivalence)', async () => {
    const { ctx } = makeCtx({ defaultUsername: 'admin' })
    addon = new OnvifProviderAddon()
    await addon.initialize(ctx)

    const hydrated = await addon.getGlobalSettings()
    expect(hydrated).not.toBeNull()
    const fields = collectFields(hydrated!.sections)
    expect(fields.find((f) => f.key === 'defaultUsername')?.value).toBe('admin')
  })

  it('updateGlobalSettings persists bare keys AND emits AddonUpdated (base settings API)', async () => {
    const { ctx, store, captured } = makeCtx()
    addon = new OnvifProviderAddon()
    await addon.initialize(ctx)

    await addon.updateGlobalSettings({ defaultUsername: 'operator' })

    expect(store['defaultUsername']).toBe('operator')
    expect(Object.keys(store).some((k) => k.includes('@'))).toBe(false)
    const updated = captured.filter((e) => e.category === EventCategory.AddonUpdated)
    expect(updated.length).toBeGreaterThan(0)
    expect(updated[0]!.data).toMatchObject({ level: 'global' })
  })

  it('_getAddonConfig reads via the sanctioned seam, not raw readAddonStore (structural)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../addon.ts'), 'utf8')
    const start = source.indexOf('private async _getAddonConfig(')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n  }', start))
    expect(body).not.toMatch(/readAddonStore/)
    expect(body).toMatch(/resolveGlobalStore/)
  })
})
