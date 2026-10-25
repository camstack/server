/**
 * R0 — battery is not exported to Alexa.
 *
 * We declared `Alexa.BatteryLevelSensor` and pushed ChangeReports for it. That
 * interface is not in Amazon's interface list (device-apis/list-of-interfaces,
 * checked 2026-10-08), and no documented interface carries a battery level:
 * `Alexa.InventoryLevelSensor` is for consumables (ink, paper) and
 * `Alexa.EndpointHealth` documents only `connectivity`. Every battery report
 * was a 202 the cloud discarded (D76's failure class), and an undeclared-
 * interface capability risks the whole endpoint.
 */
import { EventCategory } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildEndpointsForExposedDevice } from '../handlers/discovery.js'
import { LwaEventGateway, type LwaEventGatewayDeps } from '../lwa-event-gateway.js'
import { fakeBuildContext, quietLogger } from './helpers/fake-device-api.js'

describe('battery', () => {
  it('a battery camera declares no battery interface', async () => {
    const ctx = fakeBuildContext([
      { id: 7, name: 'Garden', type: 'camera', capNames: ['battery', 'motion'] },
    ])
    const endpoints = await buildEndpointsForExposedDevice(7, ctx)
    const interfaces = endpoints.flatMap((e) => e.capabilities.map((c) => c.interface))
    expect(interfaces).not.toContain('Alexa.BatteryLevelSensor')
  })

  it('the gateway does not subscribe to battery events at all', () => {
    const categories: string[] = []
    const deps: LwaEventGatewayDeps = {
      ctx: {
        eventBus: {
          subscribe: (filter: { category: string }) => {
            categories.push(filter.category)
            return () => {}
          },
        },
      } as unknown as LwaEventGatewayDeps['ctx'],
      logger: quietLogger,
      listExposed: () => [],
      listLinkedAccounts: () => [],
      listTokens: () => [],
      upsertToken: async () => {},
      removeLinkedAccount: async () => {},
      getAdvertisedBrokerUrl: () => null,
      getRegion: () => 'EU',
      getExportedSignature: () => null,
      accountMaySee: () => true,
    }
    const gateway = new LwaEventGateway(deps)
    gateway.start()
    gateway.stop()
    expect(categories).not.toContain(EventCategory.BatteryOnStatusChanged)
  })
})
