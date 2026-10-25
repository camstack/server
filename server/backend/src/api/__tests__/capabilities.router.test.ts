// server/backend/src/api/__tests__/capabilities.router.test.ts
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

describe('capabilities tRPC router logic', () => {
  let registry: CapabilityRegistry

  beforeEach(() => {
    registry = new CapabilityRegistry(createMockLogger())
    registry.ready()
  })

  it('listCapabilities returns all declared capabilities', () => {
    registry.declareCapability({ name: 'storage', scope: 'system', mode: 'singleton', methods: {} })
    registry.declareCapability({
      name: 'log-destination',
      scope: 'system',
      mode: 'collection',
      methods: {},
    })

    const list = registry.listCapabilities()
    expect(list).toHaveLength(2)
    expect(list.map((c) => c.name)).toContain('storage')
    expect(list.map((c) => c.name)).toContain('log-destination')
  })

  it('setActiveSingleton throws for unknown capability', async () => {
    await expect(registry.setActiveSingleton('nonexistent', 'some-addon')).rejects.toThrow(
      /[Uu]nknown/,
    )
  })

  it('setActiveSingleton throws for collection capability', async () => {
    registry.declareCapability({
      name: 'log-destination',
      scope: 'system',
      mode: 'collection',
      methods: {},
    })
    await expect(registry.setActiveSingleton('log-destination', 'winston')).rejects.toThrow(
      /singleton/,
    )
  })
})
