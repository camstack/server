import { describe, it, expect } from 'vitest'
import { computeBrokerCleanup } from '../ha-reconciler.js'

describe('broker cleanup on integration delete (no creation half)', () => {
  it('removes a broker only when no surviving integration references it', () => {
    const brokers = [
      { id: 'ha_001', integrationId: 'int_1' },
      { id: 'ha_002', integrationId: 'int_2' },
    ]
    const survivingIntegrationIds = new Set(['int_2'])
    expect(computeBrokerCleanup(brokers, survivingIntegrationIds)).toEqual(['ha_001'])
  })

  it('keeps a broker still referenced by a surviving integration', () => {
    const brokers = [{ id: 'ha_001', integrationId: 'int_1' }]
    expect(computeBrokerCleanup(brokers, new Set(['int_1']))).toEqual([])
  })

  it('ignores brokers with no integrationId (manually created brokers are never auto-removed)', () => {
    const brokers = [{ id: 'ha_003' }, { id: 'ha_001', integrationId: 'int_1' }]
    expect(computeBrokerCleanup(brokers, new Set())).toEqual(['ha_001'])
  })
})
