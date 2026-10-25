import { describe, it, expect } from 'vitest'
import {
  deviceAdoptionCapability,
  AdoptionFilterSchema,
} from '../capabilities/device-adoption.cap.js'

describe('device-adoption cap — generic, integrationId-keyed', () => {
  it('is a system-scoped collection cap named device-adoption', () => {
    expect(deviceAdoptionCapability.name).toBe('device-adoption')
    expect(deviceAdoptionCapability.scope).toBe('system')
    expect(deviceAdoptionCapability.mode).toBe('collection')
  })

  it('listCandidates is keyed by integrationId + pagination', () => {
    const input = deviceAdoptionCapability.methods.listCandidates.input.parse({
      integrationId: 'ha_001',
      page: 1,
      pageSize: 50,
    })
    expect(input.integrationId).toBe('ha_001')
  })

  it('adopt takes integrationId + childNativeIds + optional perCandidate', () => {
    const input = deviceAdoptionCapability.methods.adopt.input.parse({
      integrationId: 'ha_001',
      childNativeIds: ['ha:dev:abc'],
      perCandidate: { 'ha:dev:abc': { name: 'Kitchen', hiddenChildIds: ['ha:ent:x'] } },
    })
    expect(input.childNativeIds).toEqual(['ha:dev:abc'])
  })

  it('release takes integrationId + camDeviceId', () => {
    const input = deviceAdoptionCapability.methods.release.input.parse({
      integrationId: 'ha_001',
      camDeviceId: 42,
    })
    expect(input.camDeviceId).toBe(42)
  })

  it('rejects out-of-bounds pageSize', () => {
    const m = deviceAdoptionCapability.methods.listCandidates
    expect(() => m.input.parse({ integrationId: 'ha_001', page: 1, pageSize: 0 })).toThrow()
    expect(() => m.input.parse({ integrationId: 'ha_001', page: 1, pageSize: 20001 })).toThrow()
  })

  it('rejects adopt with empty childNativeIds and rejects empty name override', () => {
    const m = deviceAdoptionCapability.methods.adopt
    expect(() => m.input.parse({ integrationId: 'ha_001', childNativeIds: [] })).toThrow()
    expect(() =>
      m.input.parse({
        integrationId: 'ha_001',
        childNativeIds: ['x'],
        perCandidate: { x: { name: '' } },
      }),
    ).toThrow()
  })

  it('rejects release with a negative camDeviceId', () => {
    const m = deviceAdoptionCapability.methods.release
    expect(() => m.input.parse({ integrationId: 'ha_001', camDeviceId: -1 })).toThrow()
  })

  it('AdoptionFilter parses a granularity filter with isDefault', () => {
    const f = AdoptionFilterSchema.parse({ id: 'entities', label: 'Entities', isDefault: false })
    expect(f).toEqual({ id: 'entities', label: 'Entities', isDefault: false })
  })

  it('AdoptionFilter isDefault is optional', () => {
    const f = AdoptionFilterSchema.parse({ id: 'devices', label: 'Devices' })
    expect(f.id).toBe('devices')
    expect(f.isDefault).toBeUndefined()
  })

  it('exposes listCandidateFilters keyed by integrationId returning filters[]', () => {
    const m = deviceAdoptionCapability.methods.listCandidateFilters
    expect(m).toBeDefined()
    const input = m.input.parse({ integrationId: 'ha_001' })
    expect(input.integrationId).toBe('ha_001')
    const output = m.output.parse({
      filters: [{ id: 'devices', label: 'Devices', isDefault: true }],
    })
    expect(output.filters[0]?.id).toBe('devices')
  })

  it('listCandidates accepts an optional opaque filter string (back-compat when omitted)', () => {
    const m = deviceAdoptionCapability.methods.listCandidates
    const withFilter = m.input.parse({
      integrationId: 'ha_001',
      page: 1,
      pageSize: 50,
      filter: 'entities',
    })
    expect(withFilter.filter).toBe('entities')
    const without = m.input.parse({ integrationId: 'ha_001', page: 1, pageSize: 50 })
    expect(without.filter).toBeUndefined()
  })

  it('adopt accepts an optional opaque filter string (back-compat when omitted)', () => {
    const m = deviceAdoptionCapability.methods.adopt
    const withFilter = m.input.parse({
      integrationId: 'ha_001',
      childNativeIds: ['x'],
      filter: 'entities',
    })
    expect(withFilter.filter).toBe('entities')
    const without = m.input.parse({ integrationId: 'ha_001', childNativeIds: ['x'] })
    expect(without.filter).toBeUndefined()
  })

  it('status schema round-trips with nullable fields and counts', () => {
    const s = deviceAdoptionCapability.methods.refresh.output.parse({
      lastDiscoveryAt: null,
      candidateCount: 12,
      adoptedCount: 3,
      lastError: null,
    })
    expect(s.adoptedCount).toBe(3)
    expect(s.lastDiscoveryAt).toBeNull()
  })
})
