/** The Home Assistant target form: pick the broker, then pick the service it offers. */
import { describe, expect, it } from 'vitest'
import { HA_BROKER_KIND } from '../ha-broker-source.js'
import { HA_NOTIFICATION_KIND, homeassistantTargetKind } from '../ha-notification-output.js'

const fields = homeassistantTargetKind('provider-homeassistant').configSchema.sections.flatMap(
  (section) => section.fields,
)

describe('the homeassistant target schema', () => {
  it('asks for the broker first, as an instance-select of the Home Assistant broker kind', () => {
    expect(fields[0]).toMatchObject({
      type: 'instance-select',
      key: 'brokerId',
      functionCap: 'broker',
      kind: HA_BROKER_KIND,
    })
  })

  it('offers the notify services of that broker as a discovered select', () => {
    const service = fields.find((field) => 'key' in field && field.key === 'service')
    expect(service).toMatchObject({
      type: 'select',
      discoverOptions: { kind: HA_NOTIFICATION_KIND, dependsOn: ['brokerId'] },
    })
  })
})
