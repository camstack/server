import { describe, expect, it } from 'vitest'
import { integrationSetupSeed, readIntegrationSeed } from '../integration-setup-seed'

describe('integrationSetupSeed', () => {
  it('carries the whole prefilled config, minus the legacy marker', () => {
    expect(
      integrationSetupSeed('bosch-shc', {
        suggestedName: 'Bosch SHC [lab]',
        setupIntegration: true,
        prefilledConfig: { host: ' 192.0.2.20 ', port: 8443, label: 'lab' },
      }),
    ).toEqual({
      addonId: 'bosch-shc',
      name: 'Bosch SHC [lab]',
      config: { host: '192.0.2.20', port: 8443, label: 'lab' },
    })
  })

  it('still reads the legacy prefilledConfig marker and strips it', () => {
    expect(
      integrationSetupSeed('bosch-shc', {
        suggestedName: 'Bosch SHC [lab]',
        prefilledConfig: {
          host: '192.0.2.20',
          setupIntegration: true,
          port: 8443,
        },
      }),
    ).toEqual({
      addonId: 'bosch-shc',
      name: 'Bosch SHC [lab]',
      config: { host: '192.0.2.20', port: 8443 },
    })
  })

  it('seeds a candidate that has no host', () => {
    expect(
      integrationSetupSeed('esphome', {
        suggestedName: 'Hub',
        setupIntegration: true,
        prefilledConfig: { mdnsName: 'hub.local' },
      })?.config,
    ).toEqual({ mdnsName: 'hub.local' })
  })

  it('leaves a normal device candidate to one-click adopt', () => {
    expect(
      integrationSetupSeed('provider-onvif', {
        suggestedName: 'Lobby',
        prefilledConfig: { host: '192.0.2.30' },
      }),
    ).toBeNull()
  })
})

describe('readIntegrationSeed', () => {
  it('reads a seed left in router state and ignores anything else', () => {
    expect(
      readIntegrationSeed({
        integrationSeed: {
          addonId: 'bosch-shc',
          name: 'Bosch SHC [lab]',
          config: { host: '192.0.2.20' },
        },
      }),
    ).toEqual({
      addonId: 'bosch-shc',
      name: 'Bosch SHC [lab]',
      config: { host: '192.0.2.20' },
    })
    expect(readIntegrationSeed(null)).toBeNull()
    expect(readIntegrationSeed({ integrationSeed: { addonId: '' } })).toBeNull()
  })
})
