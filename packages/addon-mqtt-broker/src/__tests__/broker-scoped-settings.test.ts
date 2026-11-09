/**
 * The brokers, and the client credentials and topic rules they share, are integration instances.
 * The addon's settings form draws no editor at all: the `embeddedClients` / `embeddedAcl` keys
 * moved to records (a ledger migration), and no flat `embedded*` broker key remains.
 */
import { describe, expect, it } from 'vitest'

import { MqttBrokerAddon } from '../mqtt-broker.addon.js'

async function sectionIds(cap: string): Promise<readonly string[]> {
  const addon = new MqttBrokerAddon()
  return (await addon.getScopedSettingsSchema('cluster', cap))?.sections.map((s) => s.id) ?? []
}

describe('MqttBrokerAddon settings', () => {
  it('draws no settings editor for the brokers, the clients or the ACL', async () => {
    for (const cap of ['broker', 'mqtt-broker']) expect(await sectionIds(cap)).toEqual([])
    expect(await new MqttBrokerAddon().listScopedSettings()).toEqual([])
  })
})
