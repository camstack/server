/**
 * Under the unified `broker` cap — the scope Connectivity → MQTT Broker asks
 * for — the external brokers are the CONNECTIONS that page's own panel lists and
 * edits (`broker.list` / `broker.add` / `broker.setSettings` over
 * `config.brokers`). The settings form must not draw a second editor for the
 * same store beside it; the addon's full page (no cap) still does.
 */
import { describe, expect, it } from 'vitest'

import { MqttBrokerAddon } from '../mqtt-broker.addon.js'

type SchemaReader = { globalSettingsSchema(cap?: string): { sections: { id: string }[] } | null }

function sectionIds(cap?: string): readonly string[] {
  const addon = new MqttBrokerAddon() as unknown as SchemaReader
  return (addon.globalSettingsSchema(cap)?.sections ?? []).map((s) => s.id)
}

describe('MqttBrokerAddon settings scoped to the broker cap', () => {
  it('leaves the external brokers to the connections surface', () => {
    expect(sectionIds('broker')).not.toContain('mqtt-broker-external')
    expect(sectionIds('broker')).toContain('mqtt-broker-embedded')
  })

  it('keeps every section on the addon’s own page', () => {
    expect(sectionIds()).toContain('mqtt-broker-external')
    expect(sectionIds()).toContain('mqtt-broker-embedded')
  })
})
