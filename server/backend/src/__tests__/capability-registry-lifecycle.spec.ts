import { CapabilityRegistry, isInfraCapability } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

// ─── Mock helpers ────────────────────────────────────────────────────
//
// PipelineOrchestrator phase-transition + result-flow tests used to live
// in this file (importing from the now-deleted server/backend/src/core/
// orchestrator/ directory). They have been migrated into the runner package
// (`packages/addon-pipeline-runner/src/__tests__/runner.spec.ts`) which
// is the canonical home of the scheduler core.

function createMockLogger(): IScopedLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as IScopedLogger
}

function createRegistry(configReader?: (cap: string) => string | undefined): CapabilityRegistry {
  const registry = new CapabilityRegistry(createMockLogger())
  if (configReader) {
    registry.setConfigReader(configReader)
  }
  registry.ready()
  return registry
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('Full Lifecycle E2E (mock, no external services)', () => {
  describe('CapabilityRegistry boot sequence', () => {
    it('registers singleton and collection capabilities correctly', () => {
      const registry = createRegistry()

      registry.declareCapability({
        name: 'storage',
        scope: 'system',
        mode: 'singleton',
        methods: {},
      })
      registry.declareCapability({
        name: 'log-destination',
        scope: 'system',
        mode: 'collection',
        methods: {},
      })
      registry.declareCapability({
        name: 'streaming-engine',
        scope: 'system',
        mode: 'singleton',
        methods: {},
      })
      registry.declareCapability({
        name: 'analysis-pipeline',
        scope: 'system',
        mode: 'singleton',
        methods: {},
      })
      registry.declareCapability({
        name: 'device-provider',
        scope: 'system',
        mode: 'collection',
        methods: {},
      })
      registry.declareCapability({
        name: 'admin-ui',
        scope: 'system',
        mode: 'singleton',
        methods: {},
      })

      const mockStorage = { id: 'sqlite' }
      const mockLogger = { id: 'winston' }
      const mockStreaming = { id: 'restreamer' }
      const mockAnalysis = { id: 'pipeline-analysis' }
      const mockProvider = { id: 'amcrest' }

      registry.registerProvider('storage', 'sqlite-storage', mockStorage)
      registry.registerProvider('log-destination', 'winston-logging', mockLogger)
      registry.registerProvider('streaming-engine', 'restreamer', mockStreaming)
      registry.registerProvider('analysis-pipeline', 'pipeline-analysis', mockAnalysis)
      registry.registerProvider('device-provider', 'provider-amcrest', mockProvider)

      expect(registry.getSingleton('storage')).toBe(mockStorage)
      expect(registry.getCollection('log-destination')).toEqual([mockLogger])
      expect(registry.getSingleton('streaming-engine')).toBe(mockStreaming)
      expect(registry.getSingleton('analysis-pipeline')).toBe(mockAnalysis)
      expect(registry.getCollection('device-provider')).toEqual([mockProvider])

      const caps = registry.listCapabilities()
      expect(caps.length).toBeGreaterThanOrEqual(5)
    })

    it('infra capabilities are identified correctly', () => {
      expect(isInfraCapability('storage')).toBe(true)
      expect(isInfraCapability('log-destination')).toBe(true)
      expect(isInfraCapability('streaming-engine')).toBe(false)
    })
  })

  // Note: PipelineOrchestrator phase transition + detection result flow tests
  // moved to packages/addon-pipeline-runner/src/__tests__/runner.spec.ts
  // when the scheduler was extracted into the addon-pipeline-runner package.

  describe('Singleton swap', () => {
    it('swapping analysis provider changes getSingleton result', async () => {
      const registry = createRegistry()
      registry.declareCapability({
        name: 'analysis-pipeline',
        scope: 'system',
        mode: 'singleton',
        methods: {},
      })

      const analysisA = { id: 'analysis-a', processFrame: vi.fn() }
      const analysisB = { id: 'analysis-b', processFrame: vi.fn() }

      registry.registerProvider('analysis-pipeline', 'addon-a', analysisA)
      expect(registry.getSingleton('analysis-pipeline')).toBe(analysisA)

      registry.registerProvider('analysis-pipeline', 'addon-b', analysisB)

      await registry.setActiveSingleton('analysis-pipeline', 'addon-b')
      expect(registry.getSingleton('analysis-pipeline')).toBe(analysisB)
    })
  })

  describe('Collection capability add/remove', () => {
    it('adding and removing device providers', () => {
      const registry = createRegistry()
      registry.declareCapability({
        name: 'device-provider',
        scope: 'system',
        mode: 'collection',
        methods: {},
      })

      const amcrest = { id: 'amcrest', type: 'amcrest' }
      const onvif = { id: 'onvif', type: 'onvif' }

      registry.registerProvider('device-provider', 'addon-amcrest', amcrest)
      expect(registry.getCollection('device-provider')).toHaveLength(1)

      registry.registerProvider('device-provider', 'addon-onvif', onvif)
      expect(registry.getCollection('device-provider')).toHaveLength(2)

      registry.unregisterProvider('device-provider', 'addon-amcrest')
      expect(registry.getCollection('device-provider')).toHaveLength(1)
    })
  })

  describe('Capability introspection', () => {
    it('listCapabilities returns full info', () => {
      const registry = createRegistry()
      registry.declareCapability({
        name: 'storage',
        scope: 'system',
        mode: 'singleton',
        methods: {},
      })
      registry.declareCapability({
        name: 'device-provider',
        scope: 'system',
        mode: 'collection',
        methods: {},
      })

      registry.registerProvider('storage', 'sqlite', { id: 'sqlite' })
      registry.registerProvider('device-provider', 'amcrest', { id: 'amcrest' })
      registry.registerProvider('device-provider', 'onvif', { id: 'onvif' })

      const caps = registry.listCapabilities()

      const storage = caps.find((c) => c.name === 'storage')
      expect(storage).toBeDefined()
      expect(storage!.mode).toBe('singleton')
      expect(storage!.providers).toContain('sqlite')
      expect(storage!.activeProvider).toBe('sqlite')

      const providers = caps.find((c) => c.name === 'device-provider')
      expect(providers).toBeDefined()
      expect(providers!.mode).toBe('collection')
      expect(providers!.providers).toHaveLength(2)
    })
  })
})
