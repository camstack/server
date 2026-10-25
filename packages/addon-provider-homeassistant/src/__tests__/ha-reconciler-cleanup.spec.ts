import { describe, it, expect } from 'vitest'
import { computeBrokerCleanup, linkBrokersToIntegrations } from '../ha-reconciler.js'

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

describe('linkBrokersToIntegrations (persist integrationId FK)', () => {
  it('stamps integrationId onto a broker referenced by an integration that had no FK', () => {
    const brokers = [{ id: 'ha_001' }]
    const integrations = [{ id: 'int_1', brokerId: 'ha_001' }]
    expect(linkBrokersToIntegrations(brokers, integrations)).toEqual([
      { id: 'ha_001', integrationId: 'int_1' },
    ])
  })

  it('leaves a broker with no referencing integration unchanged (no FK added)', () => {
    const orphan = { id: 'ha_002' }
    const brokers = [orphan]
    const integrations = [{ id: 'int_1', brokerId: 'ha_001' }]
    const result = linkBrokersToIntegrations(brokers, integrations)
    expect(result).toEqual([{ id: 'ha_002' }])
    // unchanged entry keeps its original object reference
    expect(result[0]).toBe(orphan)
  })

  it('is idempotent — an already-correct FK yields the same object reference', () => {
    const linked = { id: 'ha_001', integrationId: 'int_1' }
    const brokers = [linked]
    const integrations = [{ id: 'int_1', brokerId: 'ha_001' }]
    const result = linkBrokersToIntegrations(brokers, integrations)
    expect(result[0]).toBe(linked)
  })

  it('replaces a stale FK when the integration now references a different broker pairing', () => {
    const brokers = [{ id: 'ha_001', integrationId: 'int_old' }]
    const integrations = [{ id: 'int_new', brokerId: 'ha_001' }]
    expect(linkBrokersToIntegrations(brokers, integrations)).toEqual([
      { id: 'ha_001', integrationId: 'int_new' },
    ])
  })

  it('ignores integrations with an undefined brokerId', () => {
    const broker = { id: 'ha_001' }
    const brokers = [broker]
    const integrations = [{ id: 'int_1', brokerId: undefined }]
    const result = linkBrokersToIntegrations(brokers, integrations)
    expect(result[0]).toBe(broker)
  })

  it('end-to-end: wizard broker (no FK) gets stamped, then is collected once its integration is deleted', () => {
    // Wizard-created broker starts with NO integrationId FK.
    const brokers = [{ id: 'ha_001' }]
    const integration = { id: 'int_1', brokerId: 'ha_001' }

    // Reconcile pass: stamp the FK from the live integration link.
    const stamped = linkBrokersToIntegrations(brokers, [integration])
    expect(stamped).toEqual([{ id: 'ha_001', integrationId: 'int_1' }])

    // Integration is later deleted → it is NOT in the surviving set.
    const survivingIntegrationIds = new Set<string>()

    // Without the FK stamp this would return [] (the original bug);
    // with it, the now-stamped broker IS collected as an orphan.
    expect(computeBrokerCleanup(stamped, survivingIntegrationIds)).toEqual(['ha_001'])
  })
})

/**
 * What `computeBrokerCleanup` is FOR, after 2026-08-05.
 *
 * It used to drive a delete. A reconcile ran while the hub was restarting,
 * `integrations.list` answered with an EMPTY array instead of throwing, nothing
 * "survived", and every broker was deleted and the empty list written back —
 * taking the operator's Home Assistant host and token with it. Nothing in the
 * addon can rebuild a broker from an integration record, so the doorbell simply
 * stopped existing and the credential was gone.
 *
 * The function is now a QUERY: the caller logs what it names and removes
 * nothing. These tests pin that the dangerous input is still recognisable —
 * because the day someone reconnects it to a delete, this is the case that
 * must stop them.
 */
describe('an empty surviving set is the dangerous input', () => {
  it('names EVERY linked broker when no integration survived', () => {
    // This is the exact shape of the incident. It is correct as a QUERY and
    // catastrophic as a delete — which is why the caller only logs it.
    const brokers = [
      { id: 'ha_004', integrationId: 'int_0017' },
      { id: 'ha_005', integrationId: 'int_0018' },
    ]
    expect(computeBrokerCleanup(brokers, new Set())).toEqual(['ha_004', 'ha_005'])
  })

  it('never names a broker that has no integration at all', () => {
    // A wizard-created broker with no FK yet is not an orphan — it is new.
    const brokers = [{ id: 'ha_009' }]
    expect(computeBrokerCleanup(brokers, new Set())).toEqual([])
  })

  it('names nothing when every integration is present', () => {
    const brokers = [{ id: 'ha_004', integrationId: 'int_0017' }]
    expect(computeBrokerCleanup(brokers, new Set(['int_0017']))).toEqual([])
  })
})
