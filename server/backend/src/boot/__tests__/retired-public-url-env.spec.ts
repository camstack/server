import { describe, expect, it } from 'vitest'
import { dropRetiredHubAddressEnv } from '../retired-public-url-env.js'

describe('dropRetiredHubAddressEnv', () => {
  it('says nothing when neither variable is set', () => {
    const env: NodeJS.ProcessEnv = { OTHER: 'x' }
    expect(dropRetiredHubAddressEnv(env)).toBeUndefined()
    expect(env).toEqual({ OTHER: 'x' })
  })

  it('warns that a set variable is ignored and removes it before runners fork', () => {
    const env: NodeJS.ProcessEnv = { CAMSTACK_HUB_PUBLIC_URL: 'https://10.0.0.5:4443' }
    const warning = dropRetiredHubAddressEnv(env)
    expect(warning).toContain('CAMSTACK_HUB_PUBLIC_URL is ignored')
    expect(warning).toContain('Network')
    expect(warning).not.toContain('10.0.0.5')
    expect(env['CAMSTACK_HUB_PUBLIC_URL']).toBeUndefined()
  })

  it('names both when both are set, and drops both', () => {
    const env: NodeJS.ProcessEnv = {
      CAMSTACK_HUB_PUBLIC_URL: 'https://a',
      CAMSTACK_PUBLIC_ORIGIN: 'https://b',
    }
    expect(dropRetiredHubAddressEnv(env)).toContain(
      'CAMSTACK_HUB_PUBLIC_URL and CAMSTACK_PUBLIC_ORIGIN are ignored',
    )
    expect(env).toEqual({})
  })
})
