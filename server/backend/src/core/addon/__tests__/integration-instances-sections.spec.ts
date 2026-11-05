import type { IIntegrationInstancesProvider, IntegrationInstance } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { instancesOfSection, kindsFor } from '../integration-instances-provider.js'

function instance(id: string, kind?: string): IntegrationInstance {
  return { id, name: id, configured: true, formValues: {}, ...(kind !== undefined ? { kind } : {}) }
}

function provider(
  kinds: ReadonlyArray<{ id: string; functionCap: string }> | undefined,
  rows: readonly IntegrationInstance[],
): IIntegrationInstancesProvider {
  return {
    describe: async () => ({
      role: 'devices',
      instanceMode: 'multiple',
      kind: 'account',
      canTest: false,
      ...(kinds !== undefined
        ? { kinds: kinds.map((k) => ({ id: k.id, label: k.id, functionCap: k.functionCap })) }
        : {}),
    }),
    instanceFormSchema: async () => ({ sections: [] }),
    listInstances: async () => rows,
    getInstance: async () => null,
    createInstance: async () => ({ id: 'x' }),
    updateInstance: async () => ({ ok: true }),
    setInstanceEnabled: async () => ({ ok: true }),
    deleteInstance: async () => ({ ok: true }),
  }
}

describe('sections of one integration-instances provider', () => {
  const dual = provider(
    [
      { id: 'account', functionCap: 'broker' },
      { id: 'integration', functionCap: 'device-provider' },
    ],
    [instance('a1', 'account'), instance('i1', 'integration'), instance('i2', 'integration')],
  )

  it('kindsFor keeps the kinds that name the function cap', async () => {
    expect((await kindsFor(dual, 'broker')).map((k) => k.id)).toEqual(['account'])
    expect(await kindsFor(dual, 'smtp-provider')).toEqual([])
  })

  it('instancesOfSection keeps the instances of those kinds only', async () => {
    expect((await instancesOfSection(dual, 'broker')).map((i) => i.id)).toEqual(['a1'])
    expect((await instancesOfSection(dual, 'device-provider')).map((i) => i.id)).toEqual([
      'i1',
      'i2',
    ])
  })

  it('a provider without kinds answers every instance in any section', async () => {
    const plain = provider(undefined, [instance('p1')])
    expect((await instancesOfSection(plain, 'broker')).map((i) => i.id)).toEqual(['p1'])
    expect(await kindsFor(plain, 'broker')).toEqual([])
  })
})
