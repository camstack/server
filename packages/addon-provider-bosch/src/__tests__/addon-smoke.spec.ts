import { describe, expect, it } from 'vitest'
import { BoschHomeComProviderAddon } from '../homecom/addon.js'
import { BoschHomeConnectProviderAddon } from '../home-connect/addon.js'
import { BoschShcProviderAddon } from '../shc/addon.js'

describe('Bosch provider addons', () => {
  it('constructs BoschShcProviderAddon', () => {
    expect(new BoschShcProviderAddon()).toBeInstanceOf(BoschShcProviderAddon)
  })

  it('constructs BoschHomeConnectProviderAddon', () => {
    expect(new BoschHomeConnectProviderAddon()).toBeInstanceOf(BoschHomeConnectProviderAddon)
  })

  it('constructs BoschHomeComProviderAddon', () => {
    expect(new BoschHomeComProviderAddon()).toBeInstanceOf(BoschHomeComProviderAddon)
  })
})
