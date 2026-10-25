/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- test file: mock AddonContext for `addon.initialize` is deliberately loose */
// server/backend/src/__tests__/addon-pages-e2e.test.ts
//
// Integration tests: verify addon-pages capability wiring end-to-end,
// BenchmarkAddon page registration, and AdminUIAddon capability provider.
//

import { CapabilityRegistry } from '@camstack/system'
import {
  type AddonContext,
  type IScopedLogger,
  makeInMemoryRecords,
  type ProviderRegistration,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Optional-module loader — returns the AdminUIAddon class if the admin-ui
// addon is built and resolvable, otherwise null. Typed against a narrow
// structural signature so the test never leaks `any` through the dynamic
// import (the module exports its own dist path which may not exist when
// the backend workspace is built in isolation).
// ---------------------------------------------------------------------------

interface AdminUIAddonInstance {
  readonly id: string
  initialize(ctx: AddonContext): Promise<
    | ProviderRegistration[]
    | void
    | undefined
    | {
        readonly providers?: readonly ProviderRegistration[]
      }
  >
}

type AdminUIAddonCtor = new () => AdminUIAddonInstance

async function loadAdminUIAddon(): Promise<AdminUIAddonCtor | null> {
  try {
    const mod = (await import('@camstack/addon-admin-ui/server/addon')) as {
      AdminUIAddon?: AdminUIAddonCtor
    }
    return mod.AdminUIAddon ?? null
  } catch {
    return null
  }
}

function createMockLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
    withTags: vi.fn(() => logger),
  }
  return logger
}

describe('Addon Pages Integration', () => {
  it('BenchmarkAddon registers addon-pages-source and provides its page list', async () => {
    const { BenchmarkAddon } = await import('@camstack/addon-benchmark')
    const addon = new BenchmarkAddon()

    // Addon has id directly — manifest is attached by AddonLoader at boot time
    expect(addon.id).toBe('benchmark')

    // Initialize with a mock context to capture registered providers.
    // Addons may register providers either via context.registerProvider() or
    // by returning AddonInitResult / ProviderRegistration[] from initialize().
    const providers = new Map<string, unknown>()
    // `ctx.api` is NOT optional for an addon that declares a settings-store
    // collection in onInitialize. BenchmarkAddon has declared its replay-runs
    // collection since 7101e0c19c (2026-08-26); this hand-rolled context had
    // no `api`, so the spec threw `ctx.api not available` for 10 days without
    // anything going red. Every real AddonContext carries `api` — supplying it
    // restores the production shape instead of narrowing the assertion.
    const declareCollection = vi.fn(async () => undefined)
    const mockContext = {
      // The addon declares its accuracy record kinds (eval-run / eval-sample)
      // at boot and refuses to start without `ctx.records`, as every real
      // hub context carries it.
      records: makeInMemoryRecords('benchmark').records,
      registerProvider: (capName: string, provider: unknown) => {
        providers.set(capName, provider)
      },
      api: {
        settingsStore: {
          declareCollection: { mutate: declareCollection },
          // Since D646 the addon also prunes its replay runs at start
          // (a retention the collection lacked) — `deleteWhere` is part of
          // the production shape it needs.
          deleteWhere: { mutate: vi.fn(async () => ({ deleted: 0 })) },
        },
      },
    }
    const result = await addon.initialize(mockContext as any)
    // Process return-value registrations (AddonInitResult.providers or ProviderRegistration[])
    if (result) {
      const regs = Array.isArray(result) ? result : ((result as any).providers ?? [])
      for (const reg of regs as ProviderRegistration[]) {
        const capName =
          typeof reg.capability === 'string'
            ? reg.capability
            : ((reg.capability as any)?.name ?? String(reg.capability))
        providers.set(capName, reg.provider)
      }
    }

    // The cap is `addon-pages-source` (the per-addon contributor); `addon-pages`
    // is the AGGREGATE the hub serves, and no addon has ever provided it. The
    // method is `listPages`, not `getPages`.
    const provider = providers.get('addon-pages-source') as
      | { listPages(): readonly unknown[] }
      | undefined
    expect(provider).toBeDefined()

    const pages = provider!.listPages()
    expect(pages).toHaveLength(1)

    expect(pages[0]).toMatchObject({
      id: 'benchmark',
      label: 'Benchmark',
      icon: 'gauge',
      path: '/addon/benchmark',
    })
  })

  it('AdminUIAddon provides admin-ui capability with static dir and version', async () => {
    // Load `@camstack/addon-admin-ui/server/addon` lazily — the package exports
    // a dist/server path that may not exist when the backend workspace is
    // built in isolation (admin-ui has its own Vite-based build). Wrapping the
    // dynamic import in a helper means the test can be typed cleanly without
    // `@ts-expect-error`: when the module is absent we skip instead of
    // leaking `any` into the rest of the spec.
    const AdminUIAddonCtor = await loadAdminUIAddon()
    if (!AdminUIAddonCtor) {
      console.warn('[addon-pages-e2e] Skipping AdminUIAddon test — module not built')
      return
    }

    const addon = new AdminUIAddonCtor()
    expect(addon.id).toBe('admin-ui')

    const providers = new Map<string, unknown>()
    const mockContext = {
      registerProvider: (capName: string, provider: unknown) => {
        providers.set(capName, provider)
      },
    }
    const result = await addon.initialize(mockContext as any)
    // Process return-value registrations (AddonInitResult.providers or ProviderRegistration[])
    if (result) {
      const regs = Array.isArray(result) ? result : ((result as any).providers ?? [])
      for (const reg of regs as ProviderRegistration[]) {
        const capName =
          typeof reg.capability === 'string'
            ? reg.capability
            : ((reg.capability as any)?.name ?? String(reg.capability))
        providers.set(capName, reg.provider)
      }
    }

    const ui = providers.get('admin-ui') as
      | {
          getStaticDir(): Promise<{ readonly staticDir: string }>
          getVersion(): Promise<{ readonly version: string }>
        }
      | undefined
    expect(ui).toBeDefined()
    expect(typeof ui!.getStaticDir).toBe('function')
    expect(typeof ui!.getVersion).toBe('function')
    // NOT a literal: `getVersion` answers the addon-admin-ui package version,
    // baked in at build time. Asserting a number here made the spec fail on
    // every release for a reason that had nothing to do with the wiring.
    const version = await ui!.getVersion()
    expect(version.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('CapabilityRegistry wires addon-pages collection providers correctly', () => {
    const registry = new CapabilityRegistry(createMockLogger())
    registry.ready()

    registry.declareCapability({
      name: 'addon-pages',
      scope: 'system',
      mode: 'collection',
      methods: {},
    })

    registry.registerProvider('addon-pages', 'benchmark', {
      id: 'benchmark',
      getPages: () => [
        {
          id: 'benchmark',
          label: 'Benchmark',
          icon: 'gauge',
          path: '/addon/benchmark',
          bundle: 'dist/pages/benchmark.js',
          element: 'camstack-benchmark',
        },
      ],
    })

    const providers = registry.getCollection<{ getPages(): unknown[] }>('addon-pages')
    expect(providers).toHaveLength(1)
    expect(providers[0]?.getPages()).toHaveLength(1)
  })

  it('CapabilityRegistry wires admin-ui singleton correctly', async () => {
    const registry = new CapabilityRegistry(createMockLogger())
    registry.ready()

    registry.declareCapability({
      name: 'admin-ui',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })

    registry.registerProvider('admin-ui', 'admin-ui', {
      getStaticDir: async () => ({ staticDir: '/some/path/dist' }),
      getVersion: async () => ({ version: '0.1.0' }),
    })

    const ui = registry.getSingleton<{ getVersion(): Promise<{ readonly version: string }> }>(
      'admin-ui',
    )
    expect(ui).toBeDefined()
    const version = await ui!.getVersion()
    expect(version.version).toBe('0.1.0')
  })
})
