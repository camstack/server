import { describe, expect, it } from 'vitest'
import { makeInMemoryRecords } from '@camstack/types'
import { oidcProviderEntryKind } from '../oidc-provider-record-kinds.js'
import { OidcProviderStore } from '../oidc-provider-store.js'

describe('OidcProviderStore', () => {
  it('round-trips a provider through the oidc-provider entry kind', async () => {
    const world = makeInMemoryRecords('auth')
    await world.records.declare({ 'oidc-provider': oidcProviderEntryKind })
    const store = OidcProviderStore.of(world.records)
    await store.replaceAll([
      {
        id: 'acme',
        displayName: 'Acme IdP',
        icon: 'shield-check',
        issuerUrl: 'https://idp.example',
        clientId: 'cid',
        clientSecret: 'sec',
        redirectUri: '',
        scopes: 'openid profile email',
        usernameClaim: 'preferred_username',
      },
    ])
    const listed = await store.listResolved()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe('acme')
    expect(listed[0]?.clientId).toBe('cid')
    expect(listed[0]?.clientSecret).toBe('sec')
  })

  it('replaceAll drops providers removed from the snapshot', async () => {
    const world = makeInMemoryRecords('auth')
    await world.records.declare({ 'oidc-provider': oidcProviderEntryKind })
    const store = OidcProviderStore.of(world.records)
    const row = {
      id: 'a',
      displayName: 'A',
      icon: 'shield-check',
      issuerUrl: 'https://idp',
      clientId: 'c',
      clientSecret: 's',
      redirectUri: '',
      scopes: 'openid',
      usernameClaim: 'sub' as const,
    }
    await store.replaceAll([row, { ...row, id: 'b', displayName: 'B' }])
    await store.replaceAll([{ ...row, id: 'b', displayName: 'B' }])
    expect((await store.listResolved()).map((p) => p.id)).toEqual(['b'])
  })
})
