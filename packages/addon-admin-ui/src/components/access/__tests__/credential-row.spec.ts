/**
 * What each hub record becomes in the one Tokens & sessions row shape, and the
 * bulk confirmation's preview text.
 */
import { describe, expect, it } from 'vitest'

import {
  describeTokenScope,
  externalIdentityKey,
  externalIdentityRow,
  linkedAppRow,
  loginSessionRow,
  tokenRow,
  type TokenSource,
} from '../credential-row'
import { bulkPreviewMessage, countLabel, statusBreakdown } from '../use-bulk-revoke'

const NOW = 1_800_000_000_000
const NAMES = new Map([
  ['u-1', 'alice'],
  ['u-2', 'bob'],
])

describe('credential rows', () => {
  it('a login session: device name, method, current flag', () => {
    const row = loginSessionRow(
      {
        id: 's1',
        userId: 'u-1',
        method: 'passkey',
        createdAt: 1,
        lastUsedAt: 2,
        expiresAt: 3,
        client: 'ua',
        ip: '10.0.0.1',
        current: true,
      },
      NAMES,
      { client: () => 'Safari on macOS', method: () => 'Passkey' },
    )
    expect(row).toMatchObject({
      name: 'Safari on macOS',
      detail: '10.0.0.1',
      ownerName: 'alice',
      kind: 'Passkey',
      status: 'current',
      expiresAt: 3,
    })
  })

  const token = (over: Partial<TokenSource> & { id: string }): TokenSource => ({
    subjectId: 'u-2',
    label: 'ops',
    scopes: ['*'],
    createdAt: 1,
    expiresAt: NOW + 1,
    lastUsedAt: null,
    revokedAt: null,
    ...over,
  })

  it('a token: revoked beats expired, expired beats active', () => {
    expect(tokenRow(token({ id: 't' }), NAMES, 'x', NOW).status).toBe('active')
    expect(tokenRow(token({ id: 't', expiresAt: NOW }), NAMES, 'x', NOW).status).toBe('expired')
    expect(
      tokenRow(token({ id: 't', expiresAt: NOW - 1, revokedAt: 5 }), NAMES, 'x', NOW).status,
    ).toBe('revoked')
  })

  it('a token shows its scopes, never a token kind; the reach facet is read from the scopes', () => {
    expect(tokenRow(token({ id: 'a' }), NAMES, 'All permissions', NOW)).toMatchObject({
      name: 'ops',
      detail: null,
      ownerName: 'bob',
      kind: 'All permissions',
      scope: 'All permissions',
    })
    const link = token({
      id: 'l',
      subjectId: 'u-9',
      label: 'kitchen wall',
      scopes: [
        { type: 'share-view', grant: { kind: 'events-view', deviceIds: [5, 6], talk: true } },
      ],
      expiresAt: null,
    })
    const scope = describeTokenScope(link.scopes[0] ?? '*', new Map([[5, 'Gate']]), () => '?')
    expect(scope).toBe('Events view + talk: Gate, #6')
    expect(tokenRow(link, NAMES, scope, NOW)).toMatchObject({
      kind: 'View link',
      ownerName: 'u-9',
      status: 'active',
      expiresAt: null,
    })
    const scoped = token({
      id: 's',
      subjectId: 'u-1',
      scopes: [{ type: 'addon', target: 'x', access: ['view'] }],
      expiresAt: NOW - 1,
    })
    expect(tokenRow(scoped, NAMES, 'addon:x [view]', NOW)).toMatchObject({
      kind: 'Scoped',
      scope: 'addon:x [view]',
      status: 'expired',
      ownerName: 'alice',
    })
  })

  it('a linked app, an identity and a legacy key', () => {
    expect(
      linkedAppRow(
        {
          id: 'o',
          userId: 'u-1',
          username: 'alice',
          integrationId: 'alexa',
          createdAt: 1,
          lastUsedAt: 2,
          revokedAt: 3,
        },
        'all devices',
      ),
    ).toMatchObject({ name: 'alexa', status: 'revoked', expiresAt: null, scope: 'all devices' })
    const identity = {
      provider: 'auth-oidc',
      subject: 'sub',
      issuer: 'https://idp',
      userId: 'u-2',
      linkedAt: 9,
    }
    expect(externalIdentityRow(identity, NAMES)).toMatchObject({
      id: externalIdentityKey(identity),
      name: 'sub',
      ownerName: 'bob',
      createdAt: 9,
    })
  })
})

describe('bulk confirmation preview', () => {
  const row = (id: string, status: 'active' | 'expired') =>
    tokenRow(
      {
        id,
        subjectId: 'u-1',
        label: `link ${id}`,
        scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [1] } }],
        createdAt: 1,
        expiresAt: status === 'expired' ? NOW - 1 : NOW + 1,
        lastUsedAt: null,
        revokedAt: null,
      },
      NAMES,
      '#1',
      NOW,
    )

  it('names the count with the right plural', () => {
    expect(countLabel(1, { key: 'access.nouns.shareLink' })).toBe('1 share link')
    expect(countLabel(3, { key: 'access.nouns.shareLink' })).toBe('3 share links')
  })

  it('breaks the selection down by status', () => {
    expect(statusBreakdown([row('a', 'active'), row('b', 'expired'), row('c', 'expired')])).toBe(
      '1 active, 2 expired',
    )
  })

  it('lists the first rows and counts the rest', () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(`r${i}`, 'expired'))
    const msg = bulkPreviewMessage(rows, { key: 'access.nouns.shareLink' })
    expect(msg).toContain('9 share links (9 expired)')
    expect(msg.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(6)
    expect(msg).toContain('…and 3 more')
  })
})
