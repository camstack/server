import { describe, expect, it } from 'vitest'
import type { IntegrationInstance, IntegrationInstanceDescription } from '@camstack/types'
import { brokerInstancesOf, type BrokerHolderData } from '../use-broker-instances'

const description: IntegrationInstanceDescription = {
  role: 'devices',
  instanceMode: 'multiple',
  kind: 'account',
  canTest: true,
  kinds: [
    { id: 'account', label: 'Account', functionCap: 'broker', brokerKind: 'matter' },
    { id: 'integration', label: 'Integration', functionCap: 'device-provider' },
  ],
}

function instance(id: string, kind: string): IntegrationInstance {
  return { id, name: `n-${id}`, configured: true, kind, formValues: {}, status: { state: 'ok' } }
}

const holder: BrokerHolderData = {
  addonId: 'addon-x',
  description,
  instances: [instance('a', 'account'), instance('b', 'integration')],
}

describe('brokerInstancesOf', () => {
  it('keeps only the instances of a broker kind, named by its brokerKind', () => {
    expect(brokerInstancesOf(holder).map((b) => [b.id, b.kind])).toEqual([['a', 'matter']])
  })
  it('narrows to one registry kind', () => {
    expect(brokerInstancesOf(holder, 'matter')).toHaveLength(1)
    expect(brokerInstancesOf(holder, 'other')).toHaveLength(0)
  })
  it('falls back to the kind id when brokerKind is absent', () => {
    const plain: BrokerHolderData = {
      ...holder,
      description: {
        ...description,
        kinds: [{ id: 'mqtt', label: 'MQTT', functionCap: 'broker' }],
      },
      instances: [instance('m', 'mqtt')],
    }
    expect(brokerInstancesOf(plain, 'mqtt').map((b) => b.id)).toEqual(['m'])
  })
})
