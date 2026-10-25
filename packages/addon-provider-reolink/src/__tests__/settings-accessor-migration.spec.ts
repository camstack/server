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
import { describe, it, expect, afterEach } from 'vitest'
import { EventCategory } from '@camstack/types'
import type { AddonContext, IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
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
    id: 'provider-reolink',
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

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
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

  it('bootstraps SMTP AUTH credentials under the SAME store keys as strings (equivalence)', async () => {
    // emailPushEnabled:false keeps the SMTP listener off (no real bind) —
    // `start()` still resolves settings, which bootstraps + persists creds.
    const { ctx, store } = makeCtx({ emailPushEnabled: false })
    addon = new ReolinkProviderAddon()
    await addon.initialize(ctx)

    await waitFor(
      () =>
        typeof store['emailPushAuthUsername'] === 'string' &&
        (store['emailPushAuthUsername'] as string).length > 0 &&
        typeof store['emailPushAuthPassword'] === 'string' &&
        (store['emailPushAuthPassword'] as string).length > 0,
    )
    // Only the two credential keys were bootstrapped — no shape change.
    expect(typeof store['emailPushAuthUsername']).toBe('string')
    expect(typeof store['emailPushAuthPassword']).toBe('string')
  })

  it('getGlobalSettings hydrates the seeded store values (equivalence)', async () => {
    const { ctx } = makeCtx({ emailPushEnabled: false, emailPushDomain: 'cams.example' })
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
    const enabled = fields.find((f) => f.key === 'emailPushEnabled')
    const domain = fields.find((f) => f.key === 'emailPushDomain')
    expect(enabled?.value).toBe(false)
    expect(domain?.value).toBe('cams.example')
  })

  it('updateGlobalSettings persists bare keys AND emits AddonUpdated (base settings API)', async () => {
    const { ctx, store, captured } = makeCtx({ emailPushEnabled: false })
    addon = new ReolinkProviderAddon()
    await addon.initialize(ctx)

    await addon.updateGlobalSettings({ emailPushDomain: 'cams.local' })

    expect(store['emailPushDomain']).toBe('cams.local')
    expect(Object.keys(store).some((k) => k.includes('@'))).toBe(false)
    const updated = captured.filter((e) => e.category === EventCategory.AddonUpdated)
    expect(updated.length).toBeGreaterThan(0)
    expect(updated[0]!.data).toMatchObject({ level: 'global' })
  })
})
