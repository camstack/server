import { describe, expect, it } from 'vitest'
import type { IntegrationInstance, IntegrationInstanceDescription } from '@camstack/types'
import {
  instancesOfHolder,
  selectableInstances,
  type InstanceHolderData,
} from '../use-instances-of-cap'

const description: IntegrationInstanceDescription = {
  role: 'devices',
  instanceMode: 'multiple',
  kind: 'account',
  canTest: true,
  kinds: [
    { id: 'account', label: 'Account', functionCap: 'broker', brokerKind: 'matter' },
    { id: 'mail', label: 'Mail', functionCap: 'smtp-provider' },
  ],
}

function instance(
  id: string,
  kind: string,
  over: Partial<IntegrationInstance> = {},
): IntegrationInstance {
  return { id, name: id, configured: true, kind, formValues: {}, ...over }
}

const holder: InstanceHolderData = {
  addonId: 'addon-x',
  description,
  instances: [instance('a', 'account'), instance('m', 'mail')],
}

describe('instancesOfHolder', () => {
  it('keeps the instances of the kinds configured for the cap, for any cap', () => {
    expect(instancesOfHolder(holder, 'broker').map((i) => i.id)).toEqual(['a'])
    expect(instancesOfHolder(holder, 'smtp-provider').map((i) => i.id)).toEqual(['m'])
    expect(instancesOfHolder(holder, 'llm')).toEqual([])
  })
  it('narrows to one kind by brokerKind ?? id', () => {
    expect(instancesOfHolder(holder, 'broker', 'matter')).toHaveLength(1)
    expect(instancesOfHolder(holder, 'broker', 'mqtt')).toHaveLength(0)
    expect(instancesOfHolder(holder, 'smtp-provider', 'mail')).toHaveLength(1)
  })
  it('carries the record switch and its form values, so a page can draw columns from them', () => {
    const [row] = instancesOfHolder(
      {
        ...holder,
        instances: [
          instance('m', 'mail', { enabled: false, formValues: { host: 'smtp.example.com' } }),
        ],
      },
      'smtp-provider',
    )
    expect(row?.enabled).toBe(false)
    expect(row?.formValues).toEqual({ host: 'smtp.example.com' })
  })
  it('a holder whose kinds serve another function holds none', () => {
    const bare: InstanceHolderData = {
      ...holder,
      description: {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'x',
        canTest: false,
        kinds: [{ id: 'relay', label: 'Relay', functionCap: 'smtp-provider' }],
      },
    }
    expect(instancesOfHolder(bare, 'broker')).toEqual([])
  })
})

describe('selectableInstances', () => {
  it('offers usable ones plus the chosen one', () => {
    const rows = instancesOfHolder(
      {
        ...holder,
        instances: [instance('ok', 'account'), instance('off', 'account', { enabled: false })],
      },
      'broker',
    )
    expect(selectableInstances(rows, null).map((i) => i.id)).toEqual(['ok'])
    expect(selectableInstances(rows, 'off').map((i) => i.id)).toEqual(['ok', 'off'])
  })
})
