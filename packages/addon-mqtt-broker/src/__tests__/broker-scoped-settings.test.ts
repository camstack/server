/**
 * Under the unified `broker` cap — the scope Connectivity → MQTT Broker asks
 * for — the external brokers are the CONNECTIONS that page's own panel lists and
 * edits (`broker.list` / `broker.add` / `broker.setSettings` over
 * `config.brokers`). The settings form must not draw a second editor for the
 * same store beside it; the addon's full page (no cap) still does.
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
    expect(await sectionIds('broker')).toContain('mqtt-broker-embedded')
  })

  it('draws no editor for the external brokers on the addon’s own page either: they are integration instances', async () => {
    expect(await sectionIds()).not.toContain('mqtt-broker-external')
    expect(await sectionIds()).toContain('mqtt-broker-embedded')
  })
})
