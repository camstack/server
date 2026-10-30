/**
 * The Alexa broker kind declares its interactive sign-in and a connection form
 * the generic broker dialog can lay out: region as a select prefilled per
 * country, the credentials the sign-in fills flagged `filledBySignIn`.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigField, IScopedLogger } from '@camstack/types'
import { buildAlexaBrokerProvider } from '../alexa-broker-provider.js'
import { AMAZON_DOMAINS, buildConnectionFormSchema } from '../config.js'

function logger(): IScopedLogger {
  const value: IScopedLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return value
    },
    withTags() {
      return value
    },
  }
  return value
}

function fields(): readonly ConfigField[] {
  return buildConnectionFormSchema().sections[0]?.fields ?? []
}

function field(key: string): ConfigField | undefined {
  return fields().find((f) => 'key' in f && f.key === key)
}

describe('Alexa broker kind descriptor', () => {
  it('advertises the sign-in routes the dialog drives', async () => {
    const provider = buildAlexaBrokerProvider({
      ownerAddonId: 'import-alexa',
      registry: {
        list: () => [],
        get: () => null,
        createEntry: async () => {
          throw new Error('unused')
        },
        removeEntry: async () => undefined,
        updateEntry: async () => {
          throw new Error('unused')
        },
        size: () => 0,
        connectedCount: () => 0,
      },
      getBrokers: () => [],
      persistBrokers: async () => undefined,
      cascadeRemoveDevices: async () => undefined,
      logger: logger(),
    })
    const providers = await provider.listProviders()
    expect(providers[0]?.kinds[0]?.signIn).toEqual({
      basePath: '/addon/import-alexa/login',
      methods: ['device-code', 'proxy'],
    })
  })

  it('offers only domains the proxy accepts, prefilled by country', () => {
    const region = field('amazonDomain')
    expect(region?.type).toBe('select')
    const options = region?.type === 'select' ? region.options.map((o) => o.value) : []
    expect(options).toEqual([...AMAZON_DOMAINS])
    const byCountry =
      region !== undefined && 'defaultByCountry' in region ? region.defaultByCountry : undefined
    expect(byCountry?.['IT']).toBe('amazon.it')
    for (const domain of Object.values(byCountry ?? {})) expect(options).toContain(domain)
  })

  it('flags the credentials the sign-in fills', () => {
    const filled = fields()
      .filter((f) => 'filledBySignIn' in f && f.filledBySignIn === true)
      .map((f) => ('key' in f ? f.key : ''))
    expect(filled).toEqual(['cookie', 'refreshToken'])
  })
})
