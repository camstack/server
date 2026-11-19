import { describe, expect, it } from 'vitest'
import { findProviderCallsInRegistryReads } from '../check-no-provider-call-in-registry-read'

const CLEAN = `
async function hidesFromIntegrations(ar, addonId) {
  return describedInstancesOf(ar, addonId) === null
}
export function buildIntegrationsProvider(ar) {
  return {
    list: async () => {
      const rows = await reg.listIntegrations()
      return rows
    },
    get: async (input) => {
      return reg.getIntegration(input.id)
    },
    update: async (input) => {
      await provider.setInstanceEnabled({ id: input.id, enabled: true })
    },
  }
}
`

describe('check-no-provider-call-in-registry-read', () => {
  it('passes a read that stays on the registry, and an update that tells the addon', () => {
    expect(findProviderCallsInRegistryReads(CLEAN)).toEqual([])
  })

  it('refuses a list that lists the addon instances', () => {
    const text = CLEAN.replace('await reg.listIntegrations()', 'await provider.listInstances()')
    expect(findProviderCallsInRegistryReads(text)).toHaveLength(1)
  })

  it('refuses a helper of the reads that describes the addon', () => {
    const text = CLEAN.replace(
      'return describedInstancesOf(ar, addonId) === null',
      'return (await getInstancesProvider(ar, addonId).describe()) === null',
    )
    expect(findProviderCallsInRegistryReads(text)[0]?.where).toContain('hidesFromIntegrations')
  })

  it('refuses the projection by name', () => {
    expect(
      findProviderCallsInRegistryReads(`${CLEAN}\nasync function projectSwitches() {}`),
    ).toHaveLength(1)
  })
})
