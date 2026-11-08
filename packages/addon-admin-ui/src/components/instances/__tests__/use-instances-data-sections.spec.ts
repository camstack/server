import { describe, expect, it } from 'vitest'
import type { IntegrationInstance, IntegrationInstanceDescription } from '@camstack/types'
import { sectionHolder, type HolderData } from '../instances-model'

const description: IntegrationInstanceDescription = {
  role: 'devices',
  instanceMode: 'multiple',
  kind: 'account',
  canTest: true,
  kinds: [
    { id: 'account', label: 'Account', functionCap: 'broker' },
    { id: 'integration', label: 'Integration', functionCap: 'device-provider' },
  ],
}
const inst = (id: string, kind: string): IntegrationInstance => ({
  id,
  name: id,
  configured: true,
  kind,
  formValues: {},
})
const holder: HolderData = {
  addonId: 'dual',
  description,
  instances: [inst('a1', 'account'), inst('i1', 'integration')],
}

describe('sectionHolder — a page section is a filter on kinds[].functionCap', () => {
  it('one holder, two kinds, two sections: each sees only its own', () => {
    const broker = sectionHolder(holder, 'broker')
    const devices = sectionHolder(holder, 'device-provider')
    expect(broker?.instances.map((i) => i.id)).toEqual(['a1'])
    expect(broker?.description.kinds?.map((k) => k.id)).toEqual(['account'])
    expect(devices?.instances.map((i) => i.id)).toEqual(['i1'])
  })
  it('a holder with nothing in the section is dropped', () => {
    expect(sectionHolder(holder, 'smtp-provider')).toBeNull()
  })
})
