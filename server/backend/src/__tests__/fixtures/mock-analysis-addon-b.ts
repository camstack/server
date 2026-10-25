// server/backend/src/__tests__/fixtures/mock-analysis-addon-b.ts
import type {
  AddonContext,
  AddonDeclaration,
  ICamstackAddon,
  ProviderRegistration,
} from '@camstack/types'
import { fixtureCap } from './fixture-cap'

export class MockAnalysisAddonB implements ICamstackAddon {
  readonly manifest: AddonDeclaration = {
    id: 'mock-analysis-b',
    name: 'Mock Analysis B',
    version: '1.0.0',
    capabilities: [{ name: 'object-detector' }],
  }

  private initialized = false
  readonly provider = { id: 'analysis-b', processFrame: async () => [] }

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
