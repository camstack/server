// server/backend/src/__tests__/fixtures/mock-log-addon.ts
import type {
  AddonContext,
  AddonDeclaration,
  ICamstackAddon,
  ProviderRegistration,
} from '@camstack/types'
import { fixtureCap } from './fixture-cap'

export class MockLogAddon implements ICamstackAddon {
  readonly manifest: AddonDeclaration = {
    id: 'mock-log-addon',
    name: 'Mock Log Destination',
    version: '1.0.0',
    capabilities: [{ name: 'log-destination' }],
  }

  private initialized = false
  readonly provider = { id: 'mock-log', write: async () => {} }

  postBrokerStart(): void {}

  async initialize(_context: AddonContext): Promise<ProviderRegistration[]> {
    this.initialized = true
    return [{ capability: fixtureCap('log-destination'), provider: this.provider }]
  }

  async shutdown(): Promise<void> {
    this.initialized = false
  }

  isInitialized(): boolean {
    return this.initialized
  }
}
