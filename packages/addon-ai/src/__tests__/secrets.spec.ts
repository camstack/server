import type { LlmProfile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { mergeProfileSecrets, REDACTED_MARKER, redactProfileForRead } from '../secrets.js'
import { makeProfile } from './support/profile.js'

const BASE: LlmProfile = makeProfile({
  id: 'a',
  name: 'A',
  kind: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: undefined,
  supportsVision: true,
})

/** BASE with its one secret field (`providerConfig.apiKey`) set. */
function keyed(apiKey: string): LlmProfile {
  return { ...BASE, providerConfig: { ...BASE.providerConfig, apiKey } }
}

describe('redactProfileForRead', () => {
  it('replaces a present apiKey with the marker', () => {
    const out = redactProfileForRead(keyed('sk-live'))
    expect(out.providerConfig.apiKey).toBe(REDACTED_MARKER)
  })
  it('leaves an absent apiKey absent (unset ≠ hidden)', () => {
    const out = redactProfileForRead(BASE)
    expect(out.providerConfig.apiKey).toBeUndefined()
  })
  it('does not mutate the input', () => {
    const p = keyed('sk-live')
    redactProfileForRead(p)
    expect(p.providerConfig.apiKey).toBe('sk-live')
  })
})

describe('mergeProfileSecrets', () => {
  it('an untouched marker keeps the stored key', () => {
    const out = mergeProfileSecrets(keyed('sk-old'), keyed(REDACTED_MARKER))
    expect(out.providerConfig.apiKey).toBe('sk-old')
  })
  it('a re-typed key replaces the stored one', () => {
    const out = mergeProfileSecrets(keyed('sk-old'), keyed('sk-new'))
    expect(out.providerConfig.apiKey).toBe('sk-new')
  })
  it('an empty string clears the stored key', () => {
    const out = mergeProfileSecrets(keyed('sk-old'), keyed(''))
    expect(out.providerConfig.apiKey).toBeUndefined()
  })
  it('a marker with no prior secret is dropped, never persisted', () => {
    const out = mergeProfileSecrets(null, keyed(REDACTED_MARKER))
    expect(out.providerConfig.apiKey).toBeUndefined()
  })
  it('undefined incoming keeps the stored key', () => {
    const out = mergeProfileSecrets(keyed('sk-old'), { ...BASE })
    expect(out.providerConfig.apiKey).toBe('sk-old')
  })
})

describe('the secret field is the kind’s, not a fixed name', () => {
  it('a kind with no secret field passes its providerConfig through untouched', () => {
    const apple = makeProfile({
      kind: 'apple-foundation',
      baseUrl: undefined,
      providerConfig: { nodeId: 'mac', apiKey: 'not-a-secret-here' },
    })
    expect(redactProfileForRead(apple).providerConfig).toEqual({
      nodeId: 'mac',
      apiKey: 'not-a-secret-here',
    })
  })
  it('a kind change never inherits the previous kind’s key', () => {
    const out = mergeProfileSecrets(keyed('sk-old'), {
      ...BASE,
      kind: 'anthropic',
      providerConfig: { apiKey: REDACTED_MARKER },
    })
    expect(out.providerConfig.apiKey).toBeUndefined()
  })
})
