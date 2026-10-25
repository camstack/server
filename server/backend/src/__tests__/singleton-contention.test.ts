/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- test file, mock typing */
// server/backend/src/__tests__/singleton-contention.test.ts
//
// Server-level E2E tests for SINGLETON CAPABILITY CONTENTION: the scenario
// where two addons both register a provider for the same `mode: 'singleton'`
// capability. Regression coverage for the production collision where
// `decoder-nodeav` and `decoder-ffmpeg` both registered the singleton
// `decoder` cap.
//
// NOTE: file is intentionally NOT named `*-e2e.test.ts` — `vitest.config.ts`
// excludes the `**/*e2e*.test.ts` glob (those are full-server-boot suites).
// This suite uses the lightweight `TestAddonHarness` and runs in the default
// `npm run test` pass.
//
// Mirrors the `TestAddonHarness` style of `capability-e2e.test.ts` and reuses
// the `mock-analysis-addon-a` / `mock-analysis-addon-b` fixtures — both of
// which register the singleton `object-detector` cap, i.e. they ARE the
// contention scenario.
//
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CapabilityRegistry } from '@camstack/system'
import type { IScopedLogger, CapabilityDeclaration } from '@camstack/types'
import { MockAnalysisAddonA } from './fixtures/mock-analysis-addon-a'
import { MockAnalysisAddonB } from './fixtures/mock-analysis-addon-b'
import type { ICamstackAddon } from '@camstack/types'

// --- Helpers ----------------------------------------------------------------

function createMockLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

interface AddonEntry {
  readonly addon: ICamstackAddon
  initialized: boolean
}

/**
 * Lightweight harness that mirrors AddonRegistryService boot sequence
 * without requiring NestJS DI. Same shape as `capability-e2e.test.ts`'s
 * harness, trimmed to the methods the contention scenarios exercise.
 */
class TestAddonHarness {
  readonly registry: CapabilityRegistry
  private readonly addonEntries = new Map<string, AddonEntry>()

  constructor(configPrefs: Record<string, string> = {}) {
    this.registry = new CapabilityRegistry(createMockLogger())
    this.registry.setConfigReader((cap) => configPrefs[cap])
    this.registry.ready()
  }

  /** Register an addon (mimics AddonRegistryService.registerAddon) */
  registerAddon(addon: ICamstackAddon): void {
    const id = addon.manifest?.id
    if (id === undefined) throw new Error('a fixture addon declares its manifest')
    this.addonEntries.set(id, { addon, initialized: false })
  }

  /** Declare capabilities from an addon manifest. Mode inferred per-name. */
  declareCapabilities(addon: ICamstackAddon): void {
    const caps = this.getAddonCapabilities(addon)
    for (const cap of caps) {
      const mode = cap.name === 'log-destination' ? ('collection' as const) : ('singleton' as const)
      this.registry.declareCapability({ name: cap.name, scope: 'system', mode, methods: {} })
      this.registry.declareFromManifest(cap)
    }
  }

  /** Initialize an addon and wire its capabilities into the registry. */
  async initializeAddon(id: string): Promise<void> {
    const entry = this.addonEntries.get(id)
    if (!entry) throw new Error(`Addon "${id}" not registered`)
    if (entry.initialized) return

    const context = {
      registerProvider: (capName: string, provider: unknown) => {
        this.registry.registerProvider(capName, id, provider)
      },
    } as any
    const result = await entry.addon.initialize(context)
    if (result) {
      const regs = Array.isArray(result) ? result : ((result as any).providers ?? [])
      for (const reg of regs) {
        const capName: string =
          typeof reg.capability === 'string'
            ? reg.capability
            : ((reg.capability as any)?.name ?? String(reg.capability))
        this.registry.registerProvider(capName, id, reg.provider)
      }
    }
    entry.initialized = true
  }

  /** Shutdown an addon and unregister its capabilities. */
  async shutdownAddon(id: string): Promise<void> {
    const entry = this.addonEntries.get(id)
    if (!entry) throw new Error(`Addon "${id}" not registered`)

    const caps = this.getAddonCapabilities(entry.addon)
    for (const cap of caps) {
      this.registry.unregisterProvider(cap.name, id)
    }
    await entry.addon.shutdown()
    entry.initialized = false
  }

  private getAddonCapabilities(addon: ICamstackAddon): CapabilityDeclaration[] {
    const manifest = addon.manifest as any
    if (!manifest.capabilities) return []
    return manifest.capabilities.map((cap: string | CapabilityDeclaration) => {
      if (typeof cap === 'string') {
        const decl: CapabilityDeclaration = { name: cap }
        return decl
      }
      return cap
    })
  }
}

// ---------------------------------------------------------------------------
// 1. Two addons register the same singleton cap
// ---------------------------------------------------------------------------
describe('Singleton contention E2E: two addons on the same singleton cap', () => {
  it('first-registered addon wins as active; registry tracks BOTH providers', async () => {
    const harness = new TestAddonHarness()
    const analysisA = new MockAnalysisAddonA()
    const analysisB = new MockAnalysisAddonB()

    harness.registerAddon(analysisA)
    harness.registerAddon(analysisB)
    harness.declareCapabilities(analysisA)
    harness.declareCapabilities(analysisB)

    // A initializes first → it becomes the default active singleton.
    await harness.initializeAddon('mock-analysis-a')
    await harness.initializeAddon('mock-analysis-b')

    // Active resolution: first-registered wins (no configReader preference).
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisA.provider)
    expect(harness.registry.getSingletonAddonId('object-detector')).toBe('mock-analysis-a')

    // ...but the registry is aware of BOTH — B did not get rejected, it is a
    // legitimate alternative provider the operator can switch to.
    const info = harness.registry.listCapabilities().find((c) => c.name === 'object-detector')!
    expect(info.providers).toEqual(expect.arrayContaining(['mock-analysis-a', 'mock-analysis-b']))
    expect(info.providers).toHaveLength(2)
    expect(info.activeProvider).toBe('mock-analysis-a')

    // Both providers individually addressable.
    expect(harness.registry.getProviderByAddon('object-detector', 'mock-analysis-a')).toBe(
      analysisA.provider,
    )
    expect(harness.registry.getProviderByAddon('object-detector', 'mock-analysis-b')).toBe(
      analysisB.provider,
    )
  })

  it('honours a configReader preference for the SECOND addon over first-registered', async () => {
    // Operator persisted a preference for B (the decoder-ffmpeg-style case
    // where the non-default addon is the desired one).
    const harness = new TestAddonHarness({ 'object-detector': 'mock-analysis-b' })
    const analysisA = new MockAnalysisAddonA()
    const analysisB = new MockAnalysisAddonB()

    harness.registerAddon(analysisA)
    harness.registerAddon(analysisB)
    harness.declareCapabilities(analysisA)
    harness.declareCapabilities(analysisB)

    // A registers first, but configReader prefers B.
    await harness.initializeAddon('mock-analysis-a')
    await harness.initializeAddon('mock-analysis-b')

    expect(harness.registry.getSingleton('object-detector')).toBe(analysisB.provider)
    expect(harness.registry.getSingletonAddonId('object-detector')).toBe('mock-analysis-b')
  })
})

// ---------------------------------------------------------------------------
// 2. Consumer waits for the cap before any provider exists
// ---------------------------------------------------------------------------
describe('Singleton contention E2E: waitForProvider before registration', () => {
  it('a wait started before any provider resolves once the provider registers', async () => {
    const harness = new TestAddonHarness()
    const analysisA = new MockAnalysisAddonA()

    harness.registerAddon(analysisA)
    harness.declareCapabilities(analysisA)

    // Consumer begins waiting BEFORE the addon initializes — no provider yet.
    const waitPromise = harness.registry.waitForProvider(
      'object-detector',
      'mock-analysis-a',
      5_000,
    )

    // Addon initializes shortly after → registerProvider fulfils the waiter.
    setTimeout(() => {
      void harness.initializeAddon('mock-analysis-a')
    }, 10)

    const resolved = await waitPromise
    expect(resolved).toBe(analysisA.provider)
  })

  it('a wait for addon B is NOT fulfilled when only addon A registers for the same singleton cap', async () => {
    const harness = new TestAddonHarness()
    const analysisA = new MockAnalysisAddonA()
    const analysisB = new MockAnalysisAddonB()

    harness.registerAddon(analysisA)
    harness.registerAddon(analysisB)
    harness.declareCapabilities(analysisA)
    harness.declareCapabilities(analysisB)

    // Consumer waits specifically for B's provider.
    let resolved = false
    const waitPromise = harness.registry
      .waitForProvider('object-detector', 'mock-analysis-b', 200)
      .then((p) => {
        resolved = true
        return p
      })

    // Only A registers — same cap, different addon. Must NOT unblock the wait.
    await harness.initializeAddon('mock-analysis-a')

    const result = await waitPromise
    expect(resolved).toBe(true)
    expect(result).toBeNull() // timed out — the wait keyed on (cap, addonId)
  })
})

// ---------------------------------------------------------------------------
// 3. The active provider is removed/unregistered
// ---------------------------------------------------------------------------
describe('Singleton contention E2E: active provider removed', () => {
  it('removing the ACTIVE provider promotes the still-registered B', async () => {
    const harness = new TestAddonHarness()
    const analysisA = new MockAnalysisAddonA()
    const analysisB = new MockAnalysisAddonB()

    harness.registerAddon(analysisA)
    harness.registerAddon(analysisB)
    harness.declareCapabilities(analysisA)
    harness.declareCapabilities(analysisB)

    await harness.initializeAddon('mock-analysis-a') // A → active
    await harness.initializeAddon('mock-analysis-b') // B → registered, inactive

    expect(harness.registry.getSingleton('object-detector')).toBe(analysisA.provider)

    // Remove the active provider A.
    await harness.shutdownAddon('mock-analysis-a')

    // `unregisterProvider` promotes the still-registered B instead of
    // leaving the singleton cap dead. With no `configReader` preference it
    // falls back to the first remaining provider — here `mock-analysis-b`.
    // (Regression anchor for the decoder-ffmpeg/decoder-nodeav incident:
    // uninstalling one decoder addon must not take the cap offline.)
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisB.provider)
    expect(harness.registry.getSingletonAddonId('object-detector')).toBe('mock-analysis-b')

    const info = harness.registry.listCapabilities().find((c) => c.name === 'object-detector')!
    expect(info.providers).toEqual(['mock-analysis-b'])
    expect(info.activeProvider).toBe('mock-analysis-b')
    expect(harness.registry.getProviderByAddon('object-detector', 'mock-analysis-b')).toBe(
      analysisB.provider,
    )
  })

  it('removing a NON-active provider keeps the active one untouched', async () => {
    const harness = new TestAddonHarness()
    const analysisA = new MockAnalysisAddonA()
    const analysisB = new MockAnalysisAddonB()

    harness.registerAddon(analysisA)
    harness.registerAddon(analysisB)
    harness.declareCapabilities(analysisA)
    harness.declareCapabilities(analysisB)

    await harness.initializeAddon('mock-analysis-a') // A → active
    await harness.initializeAddon('mock-analysis-b') // B → inactive

    // Remove the INACTIVE provider B.
    await harness.shutdownAddon('mock-analysis-b')

    // A stays active and resolvable — no disturbance.
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisA.provider)
    expect(harness.registry.getSingletonAddonId('object-detector')).toBe('mock-analysis-a')
    const info = harness.registry.listCapabilities().find((c) => c.name === 'object-detector')!
    expect(info.providers).toEqual(['mock-analysis-a'])
  })
})

// ---------------------------------------------------------------------------
// 4. Re-registration after removal
// ---------------------------------------------------------------------------
describe('Singleton contention E2E: re-registration after removal', () => {
  it('re-registering A after removal does not displace the promoted B', async () => {
    const harness = new TestAddonHarness()
    const analysisA = new MockAnalysisAddonA()
    const analysisB = new MockAnalysisAddonB()

    harness.registerAddon(analysisA)
    harness.registerAddon(analysisB)
    harness.declareCapabilities(analysisA)
    harness.declareCapabilities(analysisB)

    await harness.initializeAddon('mock-analysis-a') // A → active
    await harness.initializeAddon('mock-analysis-b') // B → inactive

    // Remove A → B is promoted to active (see scenario 3).
    await harness.shutdownAddon('mock-analysis-a')
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisB.provider)

    // Re-register A. `registerProvider`'s singleton branch only auto-promotes
    // a fresh provider when `activeAddonId === null` — but B already holds it,
    // so A re-registers without displacing B. (An operator who wants A back
    // active switches it explicitly via setActiveSingleton.)
    await harness.initializeAddon('mock-analysis-a')

    expect(harness.registry.getSingleton('object-detector')).toBe(analysisB.provider)
    expect(harness.registry.getSingletonAddonId('object-detector')).toBe('mock-analysis-b')
    const info = harness.registry.listCapabilities().find((c) => c.name === 'object-detector')!
    expect(info.providers).toEqual(expect.arrayContaining(['mock-analysis-a', 'mock-analysis-b']))
    expect(info.providers).toHaveLength(2)
  })

  it('re-registering the SAME (cap, addonId) pair without unregistering first throws', async () => {
    const harness = new TestAddonHarness()
    const analysisA = new MockAnalysisAddonA()

    harness.registerAddon(analysisA)
    harness.declareCapabilities(analysisA)
    await harness.initializeAddon('mock-analysis-a')

    // Double-register of the same pair is a programmer error — the registry
    // throws rather than silently replacing the provider.
    expect(() =>
      harness.registry.registerProvider('object-detector', 'mock-analysis-a', { id: 'dup' }),
    ).toThrow(/already registered/)
    // Original provider preserved.
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisA.provider)
  })
})

// ---------------------------------------------------------------------------
// 5. setActiveSingleton switching
// ---------------------------------------------------------------------------
describe('Singleton contention E2E: setActiveSingleton switching', () => {
  let harness: TestAddonHarness
  let analysisA: MockAnalysisAddonA
  let analysisB: MockAnalysisAddonB

  beforeEach(async () => {
    harness = new TestAddonHarness()
    analysisA = new MockAnalysisAddonA()
    analysisB = new MockAnalysisAddonB()

    harness.registerAddon(analysisA)
    harness.registerAddon(analysisB)
    harness.declareCapabilities(analysisA)
    harness.declareCapabilities(analysisB)

    await harness.initializeAddon('mock-analysis-a')
    await harness.initializeAddon('mock-analysis-b')
  })

  it('explicitly switching the active singleton flips resolution A → B → A', async () => {
    // Default: A (first registered).
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisA.provider)

    // Switch to B.
    await harness.registry.setActiveSingleton('object-detector', 'mock-analysis-b')
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisB.provider)
    expect(harness.registry.getSingletonAddonId('object-detector')).toBe('mock-analysis-b')

    // Switch back to A.
    await harness.registry.setActiveSingleton('object-detector', 'mock-analysis-a')
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisA.provider)
    expect(harness.registry.getSingletonAddonId('object-detector')).toBe('mock-analysis-a')
  })

  it('setActiveSingleton throws when switching to an addon that never registered', async () => {
    await expect(
      harness.registry.setActiveSingleton('object-detector', 'mock-analysis-c'),
    ).rejects.toThrow(/[Nn]o provider/)
    // Active pointer unchanged after the failed switch.
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisA.provider)
  })

  it('unregistering the explicitly-selected active provider promotes the remaining one', async () => {
    // Operator explicitly selected B.
    await harness.registry.setActiveSingleton('object-detector', 'mock-analysis-b')
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisB.provider)

    // B is removed. `unregisterProvider` promotes the remaining A rather
    // than leaving the cap dead — `setActiveSingleton` set only the
    // in-memory pointer, not a persisted `configReader` preference, so the
    // fallback picks the first remaining provider.
    await harness.shutdownAddon('mock-analysis-b')
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisA.provider)
    expect(harness.registry.getSingletonAddonId('object-detector')).toBe('mock-analysis-a')
    expect(harness.registry.getProviderByAddon('object-detector', 'mock-analysis-a')).toBe(
      analysisA.provider,
    )
  })
})

// ---------------------------------------------------------------------------
// 6. Teardown / race edges
// ---------------------------------------------------------------------------
describe('Singleton contention E2E: teardown and race edges', () => {
  it('a pending wait stays pending (then times out) when the would-have-matched provider is removed before it registers again', async () => {
    const harness = new TestAddonHarness()
    const analysisA = new MockAnalysisAddonA()

    harness.registerAddon(analysisA)
    harness.declareCapabilities(analysisA)

    // A registers, then is torn down — cap currently has no provider.
    await harness.initializeAddon('mock-analysis-a')
    await harness.shutdownAddon('mock-analysis-a')

    // Consumer starts waiting for A AFTER it was torn down.
    let resolved = false
    const waitPromise = harness.registry
      .waitForProvider('object-detector', 'mock-analysis-a', 150)
      .then((p) => {
        resolved = true
        return p
      })

    // `unregisterProvider` does NOT touch `pendingWaiters`, and nothing
    // re-registers A — so the waiter simply times out to null. This pins the
    // teardown contract: removing a provider never spuriously resolves or
    // rejects an outstanding wait for that (cap, addonId).
    const result = await waitPromise
    expect(resolved).toBe(true)
    expect(result).toBeNull()
  })

  it('a wait pending across a contention swap resolves only for its OWN addonId', async () => {
    const harness = new TestAddonHarness()
    const analysisA = new MockAnalysisAddonA()
    const analysisB = new MockAnalysisAddonB()

    harness.registerAddon(analysisA)
    harness.registerAddon(analysisB)
    harness.declareCapabilities(analysisA)
    harness.declareCapabilities(analysisB)

    // Two consumers wait concurrently — one for A, one for B.
    const waitForA = harness.registry.waitForProvider('object-detector', 'mock-analysis-a', 5_000)
    const waitForB = harness.registry.waitForProvider('object-detector', 'mock-analysis-b', 5_000)

    // B registers first this time, then A.
    await harness.initializeAddon('mock-analysis-b')
    await harness.initializeAddon('mock-analysis-a')

    const [resolvedA, resolvedB] = await Promise.all([waitForA, waitForB])
    expect(resolvedA).toBe(analysisA.provider)
    expect(resolvedB).toBe(analysisB.provider)

    // B registered first → B is the active singleton despite both being present.
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisB.provider)
  })

  it('full teardown of both contending addons leaves the cap declared but empty', async () => {
    const harness = new TestAddonHarness()
    const analysisA = new MockAnalysisAddonA()
    const analysisB = new MockAnalysisAddonB()

    harness.registerAddon(analysisA)
    harness.registerAddon(analysisB)
    harness.declareCapabilities(analysisA)
    harness.declareCapabilities(analysisB)

    await harness.initializeAddon('mock-analysis-a')
    await harness.initializeAddon('mock-analysis-b')
    await harness.shutdownAddon('mock-analysis-a')
    await harness.shutdownAddon('mock-analysis-b')

    expect(harness.registry.getSingleton('object-detector')).toBeNull()
    expect(harness.registry.has('object-detector')).toBe(true) // still declared
    expect(harness.registry.isAvailable('object-detector')).toBe(false) // no providers
    const info = harness.registry.listCapabilities().find((c) => c.name === 'object-detector')!
    expect(info.providers).toHaveLength(0)
    expect(info.activeProvider).toBeNull()
  })
})
