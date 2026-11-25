import { describe, expect, it } from 'vitest'
import {
  authRejectedHint,
  MissingCredentialsError,
  resolveCredentials,
  withAuthHint,
} from '../credentials.js'
import { scrubSecrets } from '../../mcp/scrub.js'

const SESSION = { server: 'https://hub.lan:4443', token: 'tok_session' }

describe('resolveCredentials', () => {
  it('uses the cached session automatically when nothing else is given', () => {
    const r = resolveCredentials({ env: {}, loadSession: () => SESSION })
    expect(r).toMatchObject({
      server: SESSION.server,
      token: 'tok_session',
      source: 'session',
    })
  })

  it('looks the session up by the explicit --server', () => {
    let asked: string | undefined = 'unset'
    resolveCredentials({
      server: 'https://other:4443',
      env: {},
      loadSession: (s) => {
        asked = s
        return { server: 'https://other:4443', token: 'tok_other' }
      },
    })
    expect(asked).toBe('https://other:4443')
  })

  it('looks the session up by $CAMSTACK_SERVER when --server is absent (not the newest file)', () => {
    let asked: string | undefined = 'unset'
    resolveCredentials({
      env: { CAMSTACK_SERVER: 'https://from-env:4443' },
      loadSession: (s) => {
        asked = s
        return { server: 'https://from-env:4443', token: 'tok_env_host' }
      },
    })
    expect(asked).toBe('https://from-env:4443')
  })

  it('throws a MissingCredentialsError that names `camstack login`', () => {
    let caught: unknown
    try {
      resolveCredentials({
        server: 'https://hub.lan:4443',
        env: {},
        loadSession: () => null,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(MissingCredentialsError)
    const msg = (caught as Error).message
    expect(msg).toContain('https://hub.lan:4443')
    expect(msg).toContain('camstack login')
    expect(msg).not.toContain('--token-file')
  })

  it('its message survives the output scrubber: the wizard prints it to the person', () => {
    const msg = new MissingCredentialsError('https://hub.lan:4443').message
    expect(scrubSecrets(msg)).toBe(msg)
  })

  it('says "any hub" when no server is known', () => {
    expect(() => resolveCredentials({ env: {}, loadSession: () => null })).toThrow(/any hub/)
  })
})

describe('authRejectedHint', () => {
  it('explains a 401/403 against a cached session as revoked or expired', () => {
    const hint = authRejectedHint(401, 'session')
    expect(hint).toMatch(/revoked or expired/)
    expect(hint).toContain('camstack login')
    expect(authRejectedHint(403, 'session')).not.toBeNull()
  })

  it('stays silent for non-auth statuses', () => {
    expect(authRejectedHint(500, 'session')).toBeNull()
    expect(authRejectedHint(200, 'session')).toBeNull()
  })
})

describe('withAuthHint', () => {
  it('appends the hint on an auth rejection', () => {
    expect(withAuthHint('Forbidden: token not recognised', 403, 'session')).toBe(
      `Forbidden: token not recognised\n  ${authRejectedHint(403, 'session')}`,
    )
  })

  it('leaves the message alone for other statuses or an unknown source', () => {
    expect(withAuthHint('boom', 500, 'session')).toBe('boom')
    expect(withAuthHint('nope', 401, undefined)).toBe('nope')
  })
})
