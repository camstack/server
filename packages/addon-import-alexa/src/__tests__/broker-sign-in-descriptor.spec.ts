/**
 * The Alexa account connection form the instance dialog lays out: region as a select prefilled per
 * country, the credentials the sign-in fills flagged `filledBySignIn`.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigField } from '@camstack/types'
import { AMAZON_DOMAINS, buildConnectionFormSchema } from '../config.js'

function fields(): readonly ConfigField[] {
  return buildConnectionFormSchema().sections[0]?.fields ?? []
}

function field(key: string): ConfigField | undefined {
  return fields().find((f) => 'key' in f && f.key === key)
}

describe('Alexa account connection form', () => {
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

  it('does not offer the credentials the sign-in fills as form fields', () => {
    const keys = fields().map((f) => ('key' in f ? f.key : ''))
    expect(keys).not.toContain('cookie')
    expect(keys).not.toContain('refreshToken')
  })
})
