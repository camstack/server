import { describe, expect, it } from 'vitest'
import type { IntegrationInstance, IntegrationInstanceDescription } from '@camstack/types'
import {
  brokerInstancesOf,
  selectableBrokers,
  type BrokerHolderData,
} from '../use-broker-instances'

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
  it('a holder whose kinds serve another function holds no broker', () => {
    const bare: BrokerHolderData = {
      ...holder,
      description: {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'brokers',
        canTest: true,
        kinds: [{ id: 'relay', label: 'Relay', functionCap: 'smtp-provider' }],
      },
    }
    expect(brokerInstancesOf(bare)).toEqual([])
  })
})

describe('selectableBrokers', () => {
  const states: readonly IntegrationInstance[] = [
    instance('ok', 'account'),
    { ...instance('off', 'account'), enabled: false },
    { ...instance('raw', 'account'), configured: false },
    { ...instance('bad', 'account'), status: { state: 'error', label: 'Sign in again' } },
  ]
  const brokers = brokerInstancesOf({ ...holder, instances: states })

  it('marks disabled, unconfigured and failing brokers unusable', () => {
    expect(brokers.map((b) => [b.id, b.usable])).toEqual([
      ['ok', true],
      ['off', false],
      ['raw', false],
      ['bad', false],
    ])
  })
  it('offers only the usable ones when nothing is chosen', () => {
    expect(selectableBrokers(brokers, null).map((b) => b.id)).toEqual(['ok'])
  })
  it('keeps the chosen broker visible with its state even when unusable', () => {
    const shown = selectableBrokers(brokers, 'bad')
    expect(shown.map((b) => b.id)).toEqual(['ok', 'bad'])
    expect(shown[1]?.stateLabel).toBe('Sign in again')
  })
})
