import { describe, it, expect } from 'vitest'
import { HaAuthConfigSchema } from '../ha-types.js'

describe('HaAuthConfig schema validation', () => {
  it('accepts the supervisor variant', () => {
    const config = { kind: 'supervisor' as const, supervisorToken: 'tok' }
    expect(HaAuthConfigSchema.parse(config)).toEqual(config)
  })

  it('accepts the long-lived variant', () => {
    const config = {
      kind: 'long-lived' as const,
      baseUrl: 'https://ha.example:8123',
      accessToken: 'll-tok',
    }
    expect(HaAuthConfigSchema.parse(config)).toEqual(config)
  })

  it('rejects long-lived with a malformed baseUrl', () => {
    expect(() =>
      HaAuthConfigSchema.parse({
        kind: 'long-lived',
        baseUrl: 'not-a-url',
        accessToken: 'll-tok',
      }),
    ).toThrow()
  })

  it('rejects supervisor with empty token', () => {
    expect(() => HaAuthConfigSchema.parse({ kind: 'supervisor', supervisorToken: '' })).toThrow()
  })

  it('rejects unknown auth kind', () => {
    expect(() => HaAuthConfigSchema.parse({ kind: 'oauth', token: 'x' })).toThrow()
  })
})
