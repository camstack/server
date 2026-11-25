import { isSessionFile, jwtExpiryMs, normalizeHubAddress, slugForServer } from '@camstack/develop'
import { describe, expect, it } from 'vitest'
import {
  isSessionBlob,
  jwtExpiry,
  normalizeHub,
  slugForServer as localSlug,
} from '../lib/resolve-config.js'

/**
 * The nx-plugin reader is a copy of develop's session helpers (it cannot import
 * develop at bootstrap). This spec imports develop in the TEST only (specs are
 * excluded from the plugin's `tsc` build) and keeps the copies equal.
 */
const ADDRESSES = [
  'hub.example.test',
  'hub.example.test:443',
  'hub.example.test:4443',
  'HUB.Example.test:8443/path?x=1',
  'https://hub.example.test/',
  'https://hub.example.test:443',
  '192.0.2.20',
  '[::1]',
  '[::1]:8443',
  '::1',
  'https://[fe80::1]:4443/',
  'http://hub.example.test',
  'ftp://hub.example.test',
  '',
  'user@hub',
  'hub:99999',
  'hub:0',
]

function outcome(fn: () => string): string {
  try {
    return fn()
  } catch (err) {
    return `throws:${err instanceof Error ? err.message : String(err)}`
  }
}

describe('nx-plugin session reader parity with develop', () => {
  it('normalizes every address the way develop does', () => {
    for (const a of ADDRESSES) {
      expect(
        outcome(() => normalizeHub(a)),
        a,
      ).toBe(outcome(() => normalizeHubAddress(a)))
    }
  })

  it('slugs every normalized server the way develop does', () => {
    for (const a of ADDRESSES) {
      const url = outcome(() => normalizeHubAddress(a))
      if (url.startsWith('throws:')) continue
      expect(localSlug(url), a).toBe(slugForServer(url))
    }
  })

  it('judges a session blob the way develop does', () => {
    const ok = { server: 's', username: 'u', token: 't', tokenId: 'i', createdAt: 1, scopes: [] }
    const blobs: unknown[] = [
      ok,
      null,
      'x',
      { ...ok, server: 1 },
      { ...ok, username: undefined },
      { ...ok, tokenId: undefined },
      { ...ok, createdAt: '1' },
      { ...ok, scopes: 'a' },
      { ...ok, isAdmin: 'yes' },
      { ...ok, refreshToken: 3 },
      { ...ok, expiresAt: '5' },
      { ...ok, expiresAt: 5, isAdmin: true, refreshToken: 'csr_x' },
    ]
    for (const b of blobs) expect(isSessionBlob(b), JSON.stringify(b)).toBe(isSessionFile(b))
  })

  it('reads the JWT exp the way develop does', () => {
    const jwt = (claims: object): string =>
      `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
    const tokens = [jwt({ exp: 5 }), jwt({}), jwt({ exp: 'x' }), 'opaque', 'a.b', 'a.!!.c', jwt([])]
    for (const t of tokens) expect(jwtExpiry(t), t).toBe(jwtExpiryMs(t))
  })
})
