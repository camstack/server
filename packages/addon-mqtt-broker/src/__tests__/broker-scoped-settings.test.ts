/**
 * The brokers (external and onboard, the old embedded one included) are integration instances,
 * edited on the Brokers page. The addon's settings form draws no second editor for them: it keeps
 * only the credentials and the ACL the onboard brokers share, and no flat `embedded*` broker key.
 */
import { describe, expect, it } from 'vitest'

import { MqttBrokerAddon } from '../mqtt-broker.addon.js'

async function sectionIds(cap?: string): Promise<readonly string[]> {
  const addon = new MqttBrokerAddon()
  if (cap === undefined) return (await addon.getGlobalSettings())?.sections.map((s) => s.id) ?? []
  return (await addon.getScopedSettingsSchema('cluster', cap))?.sections.map((s) => s.id) ?? []
}

describe('MqttBrokerAddon settings scoped to the broker cap', () => {
  it('leaves the external brokers to the connections surface', async () => {
    expect(await sectionIds('broker')).not.toContain('mqtt-broker-external')
    expect(await sectionIds('broker')).toContain('mqtt-broker-embedded-clients')
    expect(await sectionIds('broker')).not.toContain('mqtt-broker-embedded')
  })

  it('draws no editor for the external brokers on the addon’s own page either: they are integration instances', async () => {
    expect(await sectionIds()).not.toContain('mqtt-broker-external')
    expect(await sectionIds()).toContain('mqtt-broker-embedded-acl')
    expect(await sectionIds()).not.toContain('mqtt-broker-embedded')
  })
})
