import { describe, expect, it } from 'vitest'
import type { IntegrationInstanceDescription } from '@camstack/types'
import { buildInstanceKindOptions, type DescribedHolder } from '../instance-kinds'

const dual: IntegrationInstanceDescription = {
  role: 'devices',
  instanceMode: 'multiple',
  kind: 'account',
  canTest: true,
  kinds: [
    {
      id: 'account',
      label: 'Alexa account',
      functionCap: 'broker',
      brokerKind: 'alexa',
      signIn: { basePath: '/addon/alexa/login', methods: ['proxy'] },
    },
    { id: 'integration', label: 'Alexa', functionCap: 'device-provider' },
  ],
}
const mqtt: IntegrationInstanceDescription = {
  role: 'services',
  instanceMode: 'multiple',
  kind: 'brokers',
  canTest: true,
  kinds: [{ id: 'mqtt', label: 'MQTT', functionCap: 'broker', connectPath: '/c/{{brokerId}}' }],
}
const holders: readonly DescribedHolder[] = [
  { addonId: 'alexa', description: dual },
  { addonId: 'mqtt-broker', description: mqtt },
]

describe('buildInstanceKindOptions', () => {
  it('offers only the kinds whose functionCap is the section', () => {
    const options = buildInstanceKindOptions(holders, { functionCap: 'broker' })
    expect(options.map((o) => `${o.addonId}:${o.kind}`)).toEqual([
      'alexa:account',
      'mqtt-broker:mqtt',
    ])
  })
  it('carries the sign-in contract and connect paths from the kind', () => {
    const [alexa, broker] = buildInstanceKindOptions(holders, { functionCap: 'broker' })
    expect(alexa?.signInBasePath).toBe('/addon/alexa/login')
    expect(broker?.connectPath).toBe('/c/{{brokerId}}')
  })
  it('narrows to a registry kind by brokerKind, falling back to the kind id', () => {
    expect(
      buildInstanceKindOptions(holders, { functionCap: 'broker', kind: 'alexa' }),
    ).toHaveLength(1)
    expect(buildInstanceKindOptions(holders, { functionCap: 'broker', kind: 'mqtt' })).toHaveLength(
      1,
    )
    expect(buildInstanceKindOptions(holders, { functionCap: 'broker', kind: 'none' })).toHaveLength(
      0,
    )
  })
})
