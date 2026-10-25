import { describe, expect, it } from 'vitest'
import {
  type IntegrationPolicy,
  isRedirectUriAllowed,
  validateAuthorizeQuery,
} from '../oauth2-routes.js'
import { isPrivateHost } from '../private-host.js'

describe('validateAuthorizeQuery', () => {
  const known = new Map<string, IntegrationPolicy>([['export-alexa', {}]])
  it('accepts a well-formed query for a known integration', () => {
    const r = validateAuthorizeQuery(
      {
        response_type: 'code',
        integration: 'export-alexa',
        redirect_uri: 'https://cb/r',
        state: 's',
      },
      known,
    )
    expect(r.ok).toBe(true)
  })
  it('rejects an unknown integration', () => {
    const r = validateAuthorizeQuery(
      { response_type: 'code', integration: 'nope', redirect_uri: 'https://cb/r', state: 's' },
      known,
    )
    expect(r.ok).toBe(false)
  })
  it('rejects a missing state', () => {
    const r = validateAuthorizeQuery(
      { response_type: 'code', integration: 'export-alexa', redirect_uri: 'https://cb/r' },
      known,
    )
    expect(r.ok).toBe(false)
  })
  it('rejects a non-code response_type', () => {
    const r = validateAuthorizeQuery(
      {
        response_type: 'token',
        integration: 'export-alexa',
        redirect_uri: 'https://cb/r',
        state: 's',
      },
      known,
    )
    expect(r.ok).toBe(false)
  })
})

// ── The refusal has to SAY something ───────────────────────────────────────
//
// Alexa account linking went down and the only evidence anyone had was
// `invalid_request — unknown integration`. That one string covers three
// completely different client faults — the parameter absent, the parameter
// carrying a value this hub never knew, and the parameter repeated — and it
// names neither what arrived nor what would have been accepted. It took an
// operator report to notice at all.

describe('validateAuthorizeQuery — the refusal is diagnosable', () => {
  const known = new Map<string, IntegrationPolicy>([
    ['export-alexa', {}],
    ['homeassistant', { requiresPkce: true }],
  ])
  const base = { response_type: 'code', redirect_uri: 'https://cb/r', state: 's' } as const

  it('distinguishes an ABSENT integration from an unknown one, and enumerates', () => {
    const r = validateAuthorizeQuery(base, known)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('integration parameter missing')
    expect(r.detail?.received).toBe(null)
    // The ids the hub knows go to the LOG, never to the caller.
    expect(r.diagnostics?.knownIntegrations).toEqual(['export-alexa', 'homeassistant'])
    expect(Object.keys(r.detail ?? {})).toEqual(['received'])
  })

  it('echoes the value it actually received for an unknown integration', () => {
    const r = validateAuthorizeQuery({ ...base, integration: 'alexa' }, known)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('invalid_request — unknown integration')
    expect(r.detail?.received).toBe('alexa')
    expect(r.diagnostics?.knownIntegrations).toEqual(['export-alexa', 'homeassistant'])
    expect(Object.keys(r.detail ?? {})).toEqual(['received'])
  })

  it('truncates the echoed value — it is caller-supplied', () => {
    const r = validateAuthorizeQuery({ ...base, integration: 'x'.repeat(500) }, known)
    expect(r.ok).toBe(false)
    if (r.ok) return
    const received = r.detail?.received ?? ''
    expect(received.startsWith('xxxx')).toBe(true)
    expect(received.length).toBeLessThanOrEqual(101)
  })

  // Fastify's query parser turns a repeated key into an ARRAY. The old code
  // typed `integration` as `string`, handed the array straight to `Map.get`
  // and got `undefined` — a duplicated parameter looked EXACTLY like an
  // unknown integration, which is the second way to reach the same dead end.
  it('collapses a repeat that carries ONE distinct value', () => {
    const r = validateAuthorizeQuery(
      { ...base, integration: ['export-alexa', 'export-alexa'] },
      known,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.integration).toBe('export-alexa')
  })

  it('refuses a repeat whose values CONFLICT, and says so', () => {
    const r = validateAuthorizeQuery(
      { ...base, integration: ['export-alexa', 'homeassistant'] },
      known,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('repeated')
    expect(r.detail?.received).toBe('export-alexa,homeassistant')
  })

  it('treats an empty value as absent rather than as unknown', () => {
    const r = validateAuthorizeQuery({ ...base, integration: '' }, known)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('integration parameter missing')
  })
})

describe('isRedirectUriAllowed', () => {
  const prefixes = ['https://layla.amazon.com/', 'https://pitangui.amazon.com/']

  it('returns true when redirect_uri starts with an allowed prefix', () => {
    expect(isRedirectUriAllowed('https://layla.amazon.com/oauth/callback', prefixes)).toBe(true)
    expect(isRedirectUriAllowed('https://pitangui.amazon.com/oauth/callback', prefixes)).toBe(true)
  })

  it('returns false when redirect_uri does not match any allowed prefix', () => {
    expect(isRedirectUriAllowed('https://evil.example/grab', prefixes)).toBe(false)
    expect(isRedirectUriAllowed('https://layla.amazon.com.evil.example/', prefixes)).toBe(false)
  })

  it('returns false when allowedPrefixes is empty', () => {
    expect(isRedirectUriAllowed('https://layla.amazon.com/oauth/callback', [])).toBe(false)
  })
})

// ── PKCE (the public-client half) ──────────────────────────────────────────
//
// The Home Assistant component is published source: it can hold no secret, so
// the S256 challenge is the ONLY thing binding an issued code to whoever asked
// for it. These tests are about the gate, not the crypto.

describe('validateAuthorizeQuery — PKCE', () => {
  const known = new Map<string, IntegrationPolicy>([
    ['export-alexa', {}],
    ['homeassistant', { requiresPkce: true }],
  ])
  const base = { response_type: 'code', redirect_uri: 'https://cb/r', state: 's' } as const

  it('refuses a PKCE integration with no code_challenge', () => {
    const r = validateAuthorizeQuery({ ...base, integration: 'homeassistant' }, known)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('code_challenge required')
  })

  it('accepts a PKCE integration with an S256 challenge and carries it forward', () => {
    const r = validateAuthorizeQuery(
      {
        ...base,
        integration: 'homeassistant',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
      },
      known,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.codeChallenge).toBe('abc')
  })

  it('refuses method=plain — the challenge would BE the verifier', () => {
    const r = validateAuthorizeQuery(
      {
        ...base,
        integration: 'homeassistant',
        code_challenge: 'abc',
        code_challenge_method: 'plain',
      },
      known,
    )
    expect(r.ok).toBe(false)
  })

  it('leaves a non-PKCE integration alone', () => {
    const r = validateAuthorizeQuery({ ...base, integration: 'export-alexa' }, known)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.codeChallenge).toBe('')
  })
})

// ── Private-host redirect admission ────────────────────────────────────────
//
// A self-hosted Home Assistant lives at an address the hub cannot know, so its
// callback is admitted by (exact path + private host) instead of by
// registration. The point of these tests is that this is NOT a wildcard.

describe('isRedirectUriAllowed — private-host paths', () => {
  const prefixes = ['https://my.home-assistant.io/redirect/oauth']
  const paths = ['/auth/external/callback']

  it('accepts the fixed My Home Assistant bounce', () => {
    expect(
      isRedirectUriAllowed('https://my.home-assistant.io/redirect/oauth', prefixes, paths),
    ).toBe(true)
  })

  it('accepts the local callback on a private host', () => {
    for (const uri of [
      'http://192.168.1.20:8123/auth/external/callback',
      'http://10.0.0.5:8123/auth/external/callback',
      'http://172.16.3.9:8123/auth/external/callback',
      'http://100.108.60.124:8123/auth/external/callback',
      'http://homeassistant.local:8123/auth/external/callback',
      'http://localhost:8123/auth/external/callback',
      'http://[::1]:8123/auth/external/callback',
    ]) {
      expect(isRedirectUriAllowed(uri, prefixes, paths), uri).toBe(true)
    }
  })

  it('refuses the same path on a PUBLIC host', () => {
    expect(
      isRedirectUriAllowed('https://evil.example/auth/external/callback', prefixes, paths),
    ).toBe(false)
    // 172.32 is outside RFC1918; the off-by-one is the whole point.
    expect(isRedirectUriAllowed('http://172.32.0.1/auth/external/callback', prefixes, paths)).toBe(
      false,
    )
  })

  it('refuses a different path on a private host', () => {
    expect(isRedirectUriAllowed('http://192.168.1.20:8123/evil', prefixes, paths)).toBe(false)
    // Not a prefix match either — the path must be EXACT.
    expect(
      isRedirectUriAllowed('http://192.168.1.20:8123/auth/external/callback/x', prefixes, paths),
    ).toBe(false)
  })

  it('refuses a non-http scheme and an unparsable uri', () => {
    expect(
      isRedirectUriAllowed('javascript://192.168.1.20/auth/external/callback', prefixes, paths),
    ).toBe(false)
    expect(isRedirectUriAllowed('not a url', prefixes, paths)).toBe(false)
  })

  it('changes nothing when no private paths are declared (Alexa)', () => {
    expect(isRedirectUriAllowed('http://192.168.1.20:8123/auth/external/callback', prefixes)).toBe(
      false,
    )
  })
})

describe('isPrivateHost', () => {
  it('never resolves a name — only a closed suffix list is private', () => {
    expect(isPrivateHost('nas.local')).toBe(true)
    expect(isPrivateHost('box.ts.net')).toBe(true)
    expect(isPrivateHost('svc.internal')).toBe(true)
    expect(isPrivateHost('example.com')).toBe(false)
    // A public name that merely CONTAINS a private suffix.
    expect(isPrivateHost('local.example.com')).toBe(false)
  })

  it('rejects malformed and out-of-range dotted quads', () => {
    expect(isPrivateHost('10.0.0')).toBe(false)
    expect(isPrivateHost('192.168.1.256')).toBe(false)
    expect(isPrivateHost('')).toBe(false)
  })
})
