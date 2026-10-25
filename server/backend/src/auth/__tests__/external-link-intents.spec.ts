import { describe, expect, it } from 'vitest'
import { ExternalLinkIntents } from '../external-link-intents.js'

/**
 * D782 — a link intent is the hub-side half of "Link my Authentik account":
 * minted for the SIGNED-IN user, carried through the IdP round trip as an
 * opaque handle, resolved exactly once.
 */
describe('ExternalLinkIntents', () => {
  it('mints an opaque handle that resolves once to the user and provider', () => {
    const intents = new ExternalLinkIntents({ now: () => 1_000 })
    const handle = intents.create('u-alice', 'auth-oidc/authentik')
    expect(handle).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
    expect(handle).not.toContain('u-alice')
    expect(intents.consume(handle)).toEqual({
      userId: 'u-alice',
      provider: 'auth-oidc/authentik',
    })
    expect(intents.consume(handle)).toBeNull()
  })

  it('carries a native return target through (D801)', () => {
    const intents = new ExternalLinkIntents()
    const handle = intents.create('u-alice', 'auth-oidc/a', 'camstack://auth-callback')
    expect(intents.consume(handle)).toEqual({
      userId: 'u-alice',
      provider: 'auth-oidc/a',
      returnTo: 'camstack://auth-callback',
    })
  })

  it('an expired handle resolves to nothing', () => {
    let now = 0
    const intents = new ExternalLinkIntents({ now: () => now, ttlMs: 1_000 })
    const handle = intents.create('u-alice', 'auth-oidc/authentik')
    now = 1_001
    expect(intents.consume(handle)).toBeNull()
  })

  it('an unknown handle resolves to nothing', () => {
    expect(new ExternalLinkIntents().consume('li_unknownunknownunknown')).toBeNull()
  })

  it('stays bounded: the oldest intents are dropped past the cap', () => {
    const intents = new ExternalLinkIntents({ maxEntries: 2 })
    const first = intents.create('u-1', 'auth-oidc/a')
    intents.create('u-2', 'auth-oidc/a')
    intents.create('u-3', 'auth-oidc/a')
    expect(intents.consume(first)).toBeNull()
  })
})
