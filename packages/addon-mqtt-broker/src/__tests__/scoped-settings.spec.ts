import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { MqttBrokerAddon } from '../mqtt-broker.addon.js'

/**
 * D986 M4: the MQTT broker declares its settings through the cluster hook of `mqtt-broker`, names that
 * capability up front (the first config resolve runs before the providers register), and
 * keeps the keys it always stored.
 */
class Probe extends MqttBrokerAddon {
  caps(): readonly string[] {
    return this.scopedSettingsCapabilities()
  }
}

function keysOf(schema: ConfigUISchema | null): string[] {
  if (schema === null) throw new Error('no schema declared')
  return schema.sections
    .flatMap((section) => section.fields)
    .flatMap((field) =>
      'key' in field && field.type !== 'info' && field.type !== 'separator' ? [field.key] : [],
    )
    .sort()
}

describe('the MQTT broker scoped settings', () => {
  it('names mqtt-broker and declares its keys on the cluster hook only', async () => {
    const addon = new Probe()
    expect(addon.caps()).toContain('mqtt-broker')
    expect(keysOf(await addon.getScopedSettingsSchema('cluster', 'mqtt-broker'))).toEqual(
      ['embeddedClients', 'embeddedAcl'].sort(),
    )
    expect(await addon.getScopedSettingsSchema('cluster', 'not-a-capability')).toBeNull()
  })
})
