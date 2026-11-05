import { BrokerInUseError, makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { haBrokersEntryKind, haConnectionsEntryKind } from '../broker-record-kinds.js'
import { buildHaInstances } from '../ha-instances.js'

describe('a Home Assistant connection in use', () => {
  it('names the integrations that still use it when it is refused', async () => {
    const world = makeInMemoryRecords('provider-homeassistant')
    await world.records.declare({
      brokers: haBrokersEntryKind,
      connections: haConnectionsEntryKind,
    })
    const instances = buildHaInstances(world.records)
    await instances.createInstance({ id: 'int_0062', name: 'HA home' })
    await instances.updateInstance({ id: 'int_0062', values: { brokerId: 'ha_009' } })
    const { assertBrokerUnused, brokerLinkUserFinder } = await import('@camstack/types')
    const err = await assertBrokerUnused('ha_009', [brokerLinkUserFinder(instances)]).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(BrokerInUseError)
  })
})
