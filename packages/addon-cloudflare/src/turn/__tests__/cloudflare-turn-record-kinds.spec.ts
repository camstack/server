/** The `accounts` kind: the API token is a secret path; the record is named after the addon. */
import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_TURN_DEFAULT_BODY,
  CLOUDFLARE_TURN_RECORD_ID,
  CloudflareTurnBodySchema,
  cloudflareTurnAccountsKind,
} from '../turn-record-kinds.js'

describe('cloudflareTurnAccountsKind', () => {
  it('marks the API token (and only it) as a keychain secret', () => {
    expect(cloudflareTurnAccountsKind.declaration.secretPaths).toEqual(['apiToken'])
  })

  it('is a single instance named after the addon id', () => {
    expect(CLOUDFLARE_TURN_RECORD_ID).toBe('cloudflare-turn')
  })

  it('accepts the default body (unconfigured) and rejects a body without a key id', () => {
    expect(
      CloudflareTurnBodySchema.safeParse({ name: 'x', ...CLOUDFLARE_TURN_DEFAULT_BODY }).success,
    ).toBe(true)
    expect(CloudflareTurnBodySchema.safeParse({ name: 'x' }).success).toBe(false)
  })
})
