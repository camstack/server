/**
 * An unset integration registry refuses with the reason it is unset, instead of a bare
 * "not available" (planning#440 step 5: the legacy fallback registry is gone).
 */
import { describe, expect, it } from 'vitest'
import type { AddonRegistryService } from '../../../core/addon/addon-registry.service.js'
import { requireIntegrationRegistry } from '../cap-providers.js'

function registryWith(reason: string | null): AddonRegistryService {
  const stub: Pick<
    AddonRegistryService,
    'getIntegrationRegistry' | 'getIntegrationRegistryUnavailableReason'
  > = {
    getIntegrationRegistry: () => null,
    getIntegrationRegistryUnavailableReason: () => reason,
  }
  return Object.assign(Object.create(null), stub)
}

describe('requireIntegrationRegistry', () => {
  it('names why the registry is unset', () => {
    expect(() =>
      requireIntegrationRegistry(registryWith('records wiring failed: disk full')),
    ).toThrow('IntegrationRegistry not available: records wiring failed: disk full')
  })

  it('says it is still being wired when nothing failed yet', () => {
    expect(() => requireIntegrationRegistry(registryWith(null))).toThrow(/still being wired/)
  })
})
