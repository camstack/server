// server/backend/src/core/addon/__tests__/addon-registry-capability.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CapabilityRegistry } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'

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

describe('AddonRegistryService -- CapabilityRegistry integration', () => {
  let registry: CapabilityRegistry

  beforeEach(() => {
    registry = new CapabilityRegistry(createMockLogger())
    registry.ready()
  })

  it('singleton provider is available after registerProvider', () => {
    registry.declareCapability({ name: 'storage', scope: 'system', mode: 'singleton', methods: {} })

    const mockStorageProvider = { getLocation: vi.fn() }
    registry.registerProvider('storage', 'sqlite-storage', mockStorageProvider)

    expect(registry.getSingleton('storage')).toBe(mockStorageProvider)
  })

  it('streaming-engine singleton wired after provider registers', () => {
    registry.declareCapability({
      name: 'streaming-engine',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })

    const mockEngine = { initialize: vi.fn() }
    registry.registerProvider('streaming-engine', 'restreamer', mockEngine)

    expect(registry.getSingleton('streaming-engine')).toBe(mockEngine)
  })

  it('log-destination collection receives all providers', () => {
    registry.declareCapability({
      name: 'log-destination',
      scope: 'system',
      mode: 'collection',
      methods: {},
    })

    const dest1 = { id: 'winston' }
    const dest2 = { id: 'loki' }
    registry.registerProvider('log-destination', 'winston-logging', dest1)
    registry.registerProvider('log-destination', 'loki-logging', dest2)

    expect(registry.getCollection('log-destination')).toEqual([dest1, dest2])
  })
})
