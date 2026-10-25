import { describe, it, expect } from 'vitest'
import { deviceManagerCapability } from '../capabilities/device-manager.cap.js'

describe('device-manager — device-adoption proxy methods', () => {
  it('exposes adoptionListCandidates keyed by addonId + integrationId', () => {
    const m = deviceManagerCapability.methods.adoptionListCandidates
    expect(m).toBeDefined()
    const parsed = m.input.parse({ addonId: 'ha', integrationId: 'ha_001', page: 1, pageSize: 50 })
    expect(parsed.integrationId).toBe('ha_001')
  })
  it('exposes adoptionAdopt + adoptionRelease + adoptionRefresh', () => {
    expect(deviceManagerCapability.methods.adoptionAdopt).toBeDefined()
    expect(deviceManagerCapability.methods.adoptionRelease).toBeDefined()
    expect(deviceManagerCapability.methods.adoptionRefresh).toBeDefined()
  })
})
