import { describe, it, expect } from 'vitest'
import { computeBrokerCleanup, linkBrokersToIntegrations } from '../homematic-reconciler.js'

describe('computeBrokerCleanup (broker cleanup on integration delete)', () => {
  it('removes a broker only when no surviving integration references it', () => {
    const brokers = [
      { id: 'hm_001', integrationId: 'int_1' },
      { id: 'hm_002', integrationId: 'int_2' },
    ]
    const survivingIntegrationIds = new Set(['int_2'])
    expect(computeBrokerCleanup(brokers, survivingIntegrationIds)).toEqual(['hm_001'])
  })

  it('keeps a broker still referenced by a surviving integration', () => {
    const brokers = [{ id: 'hm_001', integrationId: 'int_1' }]
    expect(computeBrokerCleanup(brokers, new Set(['int_1']))).toEqual([])
  })

  it('ignores brokers with no integrationId (manually created brokers are never auto-removed)', () => {
    const brokers = [{ id: 'hm_003' }, { id: 'hm_001', integrationId: 'int_1' }]
    expect(computeBrokerCleanup(brokers, new Set())).toEqual(['hm_001'])
  })
})

describe('linkBrokersToIntegrations (persist integrationId FK)', () => {
  it('stamps integrationId onto a broker referenced by an integration that had no FK', () => {
    const brokers = [{ id: 'hm_001' }]
    const integrations = [{ id: 'int_1', brokerId: 'hm_001' }]
    expect(linkBrokersToIntegrations(brokers, integrations)).toEqual([
      { id: 'hm_001', integrationId: 'int_1' },
    ])
  })

  it('leaves a broker with no referencing integration unchanged (no FK added)', () => {
    const orphan = { id: 'hm_002' }
    const brokers = [orphan]
    const integrations = [{ id: 'int_1', brokerId: 'hm_001' }]
    const result = linkBrokersToIntegrations(brokers, integrations)
    expect(result).toEqual([{ id: 'hm_002' }])
    // unchanged entry keeps its original object reference
    expect(result[0]).toBe(orphan)
  })

  it('is idempotent — an already-correct FK yields the same object reference', () => {
    const linked = { id: 'hm_001', integrationId: 'int_1' }
    const brokers = [linked]
    const integrations = [{ id: 'int_1', brokerId: 'hm_001' }]
    const result = linkBrokersToIntegrations(brokers, integrations)
    expect(result[0]).toBe(linked)
  })

  it('replaces a stale FK when the integration now references a different broker pairing', () => {
    const brokers = [{ id: 'hm_001', integrationId: 'int_old' }]
    const integrations = [{ id: 'int_new', brokerId: 'hm_001' }]
    expect(linkBrokersToIntegrations(brokers, integrations)).toEqual([
      { id: 'hm_001', integrationId: 'int_new' },
    ])
  })

  it('ignores integrations with an undefined brokerId', () => {
    const broker = { id: 'hm_001' }
    const brokers = [broker]
    const integrations = [{ id: 'int_1', brokerId: undefined }]
    const result = linkBrokersToIntegrations(brokers, integrations)
    expect(result[0]).toBe(broker)
  })

  it('end-to-end: wizard broker (no FK) gets stamped, then is collected once its integration is deleted', () => {
    // Wizard-created broker starts with NO integrationId FK.
    const brokers = [{ id: 'hm_001' }]
    const integration = { id: 'int_1', brokerId: 'hm_001' }

    // Reconcile pass: stamp the FK from the live integration link.
    const stamped = linkBrokersToIntegrations(brokers, [integration])
    expect(stamped).toEqual([{ id: 'hm_001', integrationId: 'int_1' }])

    // Integration is later deleted → it is NOT in the surviving set.
    const survivingIntegrationIds = new Set<string>()

    // Without the FK stamp this would return [] (the original bug);
    // with it, the now-stamped broker IS collected as an orphan.
    expect(computeBrokerCleanup(stamped, survivingIntegrationIds)).toEqual(['hm_001'])
  })
})
