// packages/system/src/kernel/__tests__/capability-registry-manifest-declarers.spec.ts
//
// `getManifestDeclarers` is what lets a caller tell "this collection is still
// filling up" from "this is all there will ever be" — the difference between a
// 503 a client should retry and a 400 it should not. It exists because every
// `oauth-integration` descriptor now comes from an addon (D101), so an absence
// during boot is normal and must not read as a refusal.
import type { IScopedLogger } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../capability-registry.js'

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

describe('CapabilityRegistry — who still owes a provider', () => {
  let registry: CapabilityRegistry

  beforeEach(() => {
    registry = new CapabilityRegistry(createMockLogger())
    registry.declareCapability({
      name: 'oauth-integration',
      scope: 'system',
      mode: 'collection',
      internal: true,
      methods: {},
    })
    registry.ready()
  })

  it('records a declarer at manifest-load time, before any provider registers', () => {
    // This is the whole point: addon manifests are parsed when the addon is
    // LOADED, which on a forked addon is long before its runner has anything
    // to register. If the answer were only available after registration it
    // would answer nothing during the window it exists for.
    registry.declareFromManifest({ name: 'oauth-integration' }, 'homeassistant-export')

    expect(registry.getManifestDeclarers('oauth-integration')).toEqual(['homeassistant-export'])
    expect(registry.hasProvider('oauth-integration', 'homeassistant-export')).toBe(false)
  })

  it('keeps listing the declarer after it registers — outstanding is (declared − registered)', () => {
    registry.declareFromManifest({ name: 'oauth-integration' }, 'export-alexa')
    registry.declareFromManifest({ name: 'oauth-integration' }, 'homeassistant-export')
    registry.registerProvider('oauth-integration', 'export-alexa', {
      getDescriptor: async () => ({}),
    })

    const outstanding = registry
      .getManifestDeclarers('oauth-integration')
      .filter((addonId) => !registry.hasProvider('oauth-integration', addonId))
    expect(outstanding).toEqual(['homeassistant-export'])
  })

  it('is empty for a capability nothing declares — an absence that IS final', () => {
    expect(registry.getManifestDeclarers('oauth-integration')).toEqual([])
  })

  it('does not double-count an addon whose manifest is re-declared on reload', () => {
    // `loadNewAddons` re-runs declareFromManifest over addons already loaded.
    registry.declareFromManifest({ name: 'oauth-integration' }, 'homeassistant-export')
    registry.declareFromManifest({ name: 'oauth-integration' }, 'homeassistant-export')
    expect(registry.getManifestDeclarers('oauth-integration')).toEqual(['homeassistant-export'])
  })

  it('records a declarer even when the capability has no definition on this node', () => {
    // `declareFromManifest` returns early for an undeclared capability. The
    // debt is still real — an addon that names a cap the hub cannot yet resolve
    // is precisely the case where "not yet" must not be reported as "never".
    registry.declareFromManifest({ name: 'not-declared-here' }, 'some-addon')
    expect(registry.getManifestDeclarers('not-declared-here')).toEqual(['some-addon'])
  })
})
