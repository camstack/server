// packages/kernel/src/__tests__/capability-registry-wrapper-metadata.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CapabilityRegistry } from '../capability-registry.js'
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

describe('CapabilityRegistry — wrapper registration from the cap definition (D4)', () => {
  let registry: CapabilityRegistry

  beforeEach(() => {
    registry = new CapabilityRegistry(createMockLogger())
    registry.ready()
  })

  it('registers a wrapper from the cap definition when the manifest carries no kind', () => {
    registry.declareCapability({
      name: 'detection-pipeline',
      scope: 'device',
      mode: 'singleton',
      kind: 'wrapper',
      defaultActive: true,
      methods: {},
    })

    // Manifest declaration carries ONLY the name — no kind/defaultActive.
    registry.declareFromManifest({ name: 'detection-pipeline' }, 'addon-pipeline')

    expect(registry.getWrappersForCap('detection-pipeline')).toEqual(['addon-pipeline'])
    expect(registry.getDefaultWrapperForCap('detection-pipeline')).toBe('addon-pipeline')
  })

  it('does not register a wrapper for a non-wrapper cap', () => {
    registry.declareCapability({
      name: 'reboot',
      scope: 'device',
      mode: 'singleton',
      methods: {},
    })

    registry.declareFromManifest({ name: 'reboot' }, 'addon-reolink')

    expect(registry.getWrappersForCap('reboot')).toEqual([])
    expect(registry.getDefaultWrapperForCap('reboot')).toBeNull()
  })

  it('does not register a wrapper when the cap is not declared yet', () => {
    registry.declareFromManifest({ name: 'never-declared' }, 'addon-x')
    expect(registry.getWrappersForCap('never-declared')).toEqual([])
  })
})
