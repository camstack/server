// server/backend/src/__tests__/fixtures/mock-storage-addon.ts
import type {
  AddonContext,
  AddonDeclaration,
  ICamstackAddon,
  ProviderRegistration,
} from '@camstack/types'
import { fixtureCap } from './fixture-cap'

/**
 * Stands in for the whole Phase-1 infra batch, because that is what
 * `INFRA_CAPABILITIES` requires before ANY other addon may boot: the concrete
 * backend (`storage-provider`), the data engine (`data-store-provider`), the
 * orchestrator (`storage`) and the door in front of it (`settings-store`).
 * Provide fewer and `TestAddonHarness.boot` refuses, which is exactly what it
 * should do — the fixture is what must keep up, not the invariant.
 */
export class MockStorageAddon implements ICamstackAddon {
  readonly manifest: AddonDeclaration = {
    id: 'mock-storage',
    name: 'Mock Storage',
    version: '1.0.0',
    capabilities: [
      { name: 'storage-provider' },
      { name: 'data-store-provider' },
      { name: 'storage' },
      { name: 'settings-store' },
    ],
  }

  private initialized = false
  readonly provider = { id: 'mock-storage', type: 'mock' }

  postBrokerStart(): void {}

  async initialize(_context: AddonContext): Promise<ProviderRegistration[]> {
    this.initialized = true
    return [
      { capability: fixtureCap('storage-provider'), provider: this.provider },
      { capability: fixtureCap('data-store-provider'), provider: this.provider },
      { capability: fixtureCap('storage'), provider: this.provider },
      { capability: fixtureCap('settings-store'), provider: this.provider },
    ]
  }

  async shutdown(): Promise<void> {
    this.initialized = false
  }

  isInitialized(): boolean {
    return this.initialized
  }
}
