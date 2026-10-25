/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- test file, mock typing */
// server/backend/src/__tests__/capability-e2e.test.ts
//
// Server-level E2E tests: exercises the CapabilityRegistry through patterns
// matching the real AddonRegistryService boot flow, using mock addons.
//

import { CapabilityRegistry, INFRA_CAPABILITIES } from '@camstack/system'
import type { CapabilityDeclaration, ICamstackAddon, IScopedLogger } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MockAnalysisAddonA } from './fixtures/mock-analysis-addon-a'
import { MockAnalysisAddonB } from './fixtures/mock-analysis-addon-b'
import { MockLogAddon } from './fixtures/mock-log-addon'
import { MockStorageAddon } from './fixtures/mock-storage-addon'

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
 * without requiring NestJS DI.
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

  /** Declare capabilities from an addon manifest.
   *  Post-session-5-A5: `declareFromManifest` no longer synthesizes a
   *  minimal CapabilityState — it only attaches metadata (dependsOn,
   *  autoActivate). We must first call `declareCapability` with a full
   *  definition for each cap so the state exists in the registry. */
  declareCapabilities(addon: ICamstackAddon): void {
    const caps = this.getAddonCapabilities(addon)
    for (const cap of caps) {
      // Create a full definition so the registry has a CapabilityState.
      // Mode is inferred from the cap name for test convenience.
      const mode = cap.name === 'log-destination' ? ('collection' as const) : ('singleton' as const)
      this.registry.declareCapability({ name: cap.name, scope: 'system', mode, methods: {} })
      this.registry.declareFromManifest(cap)
    }
  }

  /** Initialize an addon and wire its capabilities */
  async initializeAddon(id: string): Promise<void> {
    const entry = this.addonEntries.get(id)
    if (!entry) throw new Error(`Addon "${id}" not registered`)
    if (entry.initialized) return

    // Simulate minimal context with registerProvider that wires into the registry
    const context = {
      registerProvider: (capName: string, provider: unknown) => {
        this.registry.registerProvider(capName, id, provider)
      },
    } as any
    const result = await entry.addon.initialize(context)
    // Mirror the real addon-registry.service behaviour: process the return
    // value which may be ProviderRegistration[] or AddonInitResult.
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

  /** Shutdown an addon and unregister its capabilities */
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

  /** Full boot sequence mimicking AddonRegistryService.onModuleInit */
  async boot(enabledIds: string[]): Promise<void> {
    // 1. Declare capabilities from all registered addons
    for (const [, entry] of this.addonEntries) {
      this.declareCapabilities(entry.addon)
    }

    // 2. Phase 1: infra addons
    for (const infra of INFRA_CAPABILITIES) {
      const addonId = this.findAddonForCapability(infra.name, enabledIds)
      if (addonId) {
        await this.initializeAddon(addonId)
      } else if (infra.required) {
        throw new Error(`No addon provides required infrastructure capability "${infra.name}"`)
      }
    }

    // 3. Phase 2: remaining addons (dependency-ordered)
    const bootOrder = this.registry.getBootOrder()
    const infraNames = new Set(INFRA_CAPABILITIES.map((c) => c.name))

    for (const capName of bootOrder) {
      if (infraNames.has(capName)) continue
      for (const id of enabledIds) {
        const entry = this.addonEntries.get(id)
        if (!entry || entry.initialized) continue
        const provides = this.getAddonCapabilities(entry.addon)
        if (provides.some((c) => c.name === capName)) {
          await this.initializeAddon(id)
        }
      }
    }

    // 4. Enable remaining addons
    for (const id of enabledIds) {
      const entry = this.addonEntries.get(id)
      if (entry && !entry.initialized) {
        await this.initializeAddon(id)
      }
    }
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

  private findAddonForCapability(capName: string, enabledIds: string[]): string | null {
    for (const id of enabledIds) {
      const entry = this.addonEntries.get(id)
      if (!entry) continue
      const caps = this.getAddonCapabilities(entry.addon)
      if (caps.some((c) => c.name === capName)) return id
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// 1. Full boot lifecycle
// ---------------------------------------------------------------------------
describe('Server E2E: Full boot lifecycle', () => {
  it('boots infra addons first, then non-infra, all capabilities listed', async () => {
    const harness = new TestAddonHarness()

    const storageAddon = new MockStorageAddon()
    const logAddon = new MockLogAddon()
    const analysisAddonA = new MockAnalysisAddonA()

    harness.registerAddon(storageAddon)
    harness.registerAddon(logAddon)
    harness.registerAddon(analysisAddonA)

    await harness.boot(['mock-storage', 'mock-log-addon', 'mock-analysis-a'])

    // Verify infra addons enabled
    expect(storageAddon.isInitialized()).toBe(true)
    expect(logAddon.isInitialized()).toBe(true)
    expect(analysisAddonA.isInitialized()).toBe(true)

    // Verify providers accessible via registry
    expect(harness.registry.getSingleton('storage')).toBe(storageAddon.provider)
    expect(harness.registry.getCollection('log-destination')).toContain(logAddon.provider)
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisAddonA.provider)

    // Verify listCapabilities
    const list = harness.registry.listCapabilities()
    expect(list.length).toBeGreaterThanOrEqual(3)
    expect(list.find((c) => c.name === 'storage')?.activeProvider).toBe('mock-storage')
    expect(list.find((c) => c.name === 'log-destination')?.providers).toContain('mock-log-addon')
    expect(list.find((c) => c.name === 'object-detector')?.activeProvider).toBe('mock-analysis-a')
  })

  it('throws when required infra capability is missing', async () => {
    const harness = new TestAddonHarness()

    const logAddon = new MockLogAddon()
    harness.registerAddon(logAddon)

    await expect(harness.boot(['mock-log-addon'])).rejects.toThrow(/required.*storage/i)
  })
})

// ---------------------------------------------------------------------------
// 2. Singleton swap via harness
// ---------------------------------------------------------------------------
describe('Server E2E: Singleton swap', () => {
  it('swaps analysis provider via setActiveSingleton', async () => {
    const harness = new TestAddonHarness()

    const storageAddon = new MockStorageAddon()
    const analysisA = new MockAnalysisAddonA()
    const analysisB = new MockAnalysisAddonB()

    harness.registerAddon(storageAddon)
    harness.registerAddon(analysisA)
    harness.registerAddon(analysisB)

    await harness.boot(['mock-storage', 'mock-analysis-a', 'mock-analysis-b'])

    // A is default (first registered)
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisA.provider)

    // Swap to B
    await harness.registry.setActiveSingleton('object-detector', 'mock-analysis-b')
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisB.provider)
  })
})

// ---------------------------------------------------------------------------
// 3. Collection addon add/remove
// ---------------------------------------------------------------------------
describe('Server E2E: Collection addon add/remove', () => {
  it('adds and removes log destinations dynamically', async () => {
    const harness = new TestAddonHarness()

    const storageAddon = new MockStorageAddon()
    const logAddon = new MockLogAddon()

    harness.registerAddon(storageAddon)
    harness.registerAddon(logAddon)

    await harness.boot(['mock-storage', 'mock-log-addon'])

    expect(harness.registry.getCollection('log-destination')).toHaveLength(1)

    // Dynamically add a second log destination
    const logAddon2 = new MockLogAddon()

    ;(logAddon2 as any).manifest = {
      ...logAddon2.manifest,
      id: 'mock-log-addon-2',
      name: 'Mock Log Destination 2',
    }
    harness.registerAddon(logAddon2)
    harness.declareCapabilities(logAddon2)
    await harness.initializeAddon('mock-log-addon-2')

    expect(harness.registry.getCollection('log-destination')).toHaveLength(2)

    // Disable the second
    await harness.shutdownAddon('mock-log-addon-2')
    expect(harness.registry.getCollection('log-destination')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Addon disable/re-enable
// ---------------------------------------------------------------------------
describe('Server E2E: Addon disable/re-enable', () => {
  it('disabling an addon removes its provider, re-enabling restores it', async () => {
    const harness = new TestAddonHarness()

    const storageAddon = new MockStorageAddon()
    const analysisA = new MockAnalysisAddonA()

    harness.registerAddon(storageAddon)
    harness.registerAddon(analysisA)

    await harness.boot(['mock-storage', 'mock-analysis-a'])

    expect(harness.registry.getSingleton('object-detector')).toBe(analysisA.provider)

    // Disable analysis addon
    await harness.shutdownAddon('mock-analysis-a')
    expect(harness.registry.getSingleton('object-detector')).toBeNull()

    // Re-enable
    await harness.initializeAddon('mock-analysis-a')
    expect(harness.registry.getSingleton('object-detector')).toBe(analysisA.provider)
  })
})

// ---------------------------------------------------------------------------
// 5. tRPC capabilities endpoints (logic-level, no HTTP)
// ---------------------------------------------------------------------------
describe('Server E2E: tRPC capabilities endpoints (logic-level)', () => {
  let harness: TestAddonHarness

  beforeEach(async () => {
    harness = new TestAddonHarness()

    const storageAddon = new MockStorageAddon()
    const analysisA = new MockAnalysisAddonA()
    const analysisB = new MockAnalysisAddonB()
    const logAddon = new MockLogAddon()

    harness.registerAddon(storageAddon)
    harness.registerAddon(analysisA)
    harness.registerAddon(analysisB)
    harness.registerAddon(logAddon)

    await harness.boot(['mock-storage', 'mock-analysis-a', 'mock-analysis-b', 'mock-log-addon'])
  })

  it('listCapabilities returns all declared capabilities', () => {
    const list = harness.registry.listCapabilities()
    const names = list.map((c) => c.name)

    expect(names).toContain('storage')
    expect(names).toContain('object-detector')
    expect(names).toContain('log-destination')
  })

  it('getCapability for storage returns CapabilityInfo with provider', () => {
    const list = harness.registry.listCapabilities()
    const storage = list.find((c) => c.name === 'storage')

    expect(storage).toBeDefined()
    expect(storage!.mode).toBe('singleton')
    expect(storage!.providers).toContain('mock-storage')
    expect(storage!.activeProvider).toBe('mock-storage')
  })

  it('setActiveSingleton swaps the active analysis provider', async () => {
    const listBefore = harness.registry.listCapabilities()
    const analysisBefore = listBefore.find((c) => c.name === 'object-detector')!
    expect(analysisBefore.activeProvider).toBe('mock-analysis-a')

    await harness.registry.setActiveSingleton('object-detector', 'mock-analysis-b')

    const listAfter = harness.registry.listCapabilities()
    const analysisAfter = listAfter.find((c) => c.name === 'object-detector')!
    expect(analysisAfter.activeProvider).toBe('mock-analysis-b')
  })

  it('setActiveSingleton throws for unknown capability', async () => {
    await expect(harness.registry.setActiveSingleton('nonexistent', 'some-addon')).rejects.toThrow(
      /[Uu]nknown/,
    )
  })

  it('setActiveSingleton throws for collection capability', async () => {
    await expect(
      harness.registry.setActiveSingleton('log-destination', 'mock-log-addon'),
    ).rejects.toThrow(/singleton/)
  })

  it('setActiveSingleton throws for unregistered provider', async () => {
    await expect(
      harness.registry.setActiveSingleton('storage', 'nonexistent-addon'),
    ).rejects.toThrow(/[Nn]o provider/)
  })
})
