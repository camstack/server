// server/backend/src/__tests__/fixtures/mock-analysis-addon-a.ts
import type {
  AddonContext,
  AddonDeclaration,
  ICamstackAddon,
  ProviderRegistration,
} from '@camstack/types'
import { fixtureCap } from './fixture-cap'

export class MockAnalysisAddonA implements ICamstackAddon {
  readonly manifest: AddonDeclaration = {
    id: 'mock-analysis-a',
    name: 'Mock Analysis A',
    version: '1.0.0',
    capabilities: [{ name: 'object-detector' }],
  }

  private initialized = false
  readonly provider = { id: 'analysis-a', processFrame: async () => [] }

  postBrokerStart(): void {}

  async initialize(_context: AddonContext): Promise<ProviderRegistration[]> {
    this.initialized = true
    return [{ capability: fixtureCap('object-detector'), provider: this.provider }]
  }

  async shutdown(): Promise<void> {
    this.initialized = false
  }

  isInitialized(): boolean {
    return this.initialized
  }
}
