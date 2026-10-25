import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  beginHomeComSignIn,
  completeHomeComSignIn,
  HomeComLoginError,
  HOMECOM_REDIRECT_URI,
  parseHomeComCallback,
} from '../homecom-login.js'
import { homeComActions } from '../custom-actions.js'
import { buildHomeComFormSchema, connectionFromSettings } from '../config.js'
import type { FetchFn } from '../homecom-api-client.js'

function idToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url')
  return `e30.${payload}.sig`
}

function tokenFetch(
  respond: (body: URLSearchParams) => { status: number; json: unknown },
  seen: { url: string; body: URLSearchParams }[] = [],
): FetchFn {
  return async (url, init) => {
    const body = new URLSearchParams(init?.body ?? '')
    seen.push({ url, body })
    const out = respond(body)
    return {
      ok: out.status < 400,
      status: out.status,
      json: async () => out.json,
    }
  }
}

describe('beginHomeComSignIn', () => {
  it('builds a PKCE login link against SingleKey ID', () => {
    const started = beginHomeComSignIn()
    const url = new URL(started.authorizeUrl)
    expect(url.origin).toBe('https://singlekey-id.com')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(HOMECOM_REDIRECT_URI)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(started.verifier).digest('base64url'),
    )
    expect(url.searchParams.get('state')).toBe(started.state)
  })
})

describe('parseHomeComCallback', () => {
  const state = 'st-1'
  it('takes the code from the full app redirect', () => {
    expect(parseHomeComCallback(`${HOMECOM_REDIRECT_URI}?code=abc&state=${state}`, state)).toBe(
      'abc',
    )
  })
  it('takes the code from a browser-copied https address and from the bare code', () => {
    expect(parseHomeComCallback(`https://x.example/cb?state=${state}&code=abc`, state)).toBe('abc')
    expect(parseHomeComCallback('  abc-123_XYZ  ', state)).toBe('abc-123_XYZ')
  })
  it('rejects a wrong state, an empty paste and a denied login', () => {
    expect(() => parseHomeComCallback(`${HOMECOM_REDIRECT_URI}?code=abc&state=zzz`, state)).toThrow(
      expect.objectContaining({ reason: 'state-mismatch' }),
    )
    expect(() => parseHomeComCallback('', state)).toThrow(
      expect.objectContaining({ reason: 'empty' }),
    )
    expect(() =>
      parseHomeComCallback(`${HOMECOM_REDIRECT_URI}?error=access_denied&state=${state}`, state),
    ).toThrow(expect.objectContaining({ reason: 'denied' }))
  })
})

describe('completeHomeComSignIn', () => {
  it('exchanges the code with the verifier and returns the tokens and the account email', async () => {
    const seen: { url: string; body: URLSearchParams }[] = []
    const fetchFn = tokenFetch(
      () => ({
        status: 200,
        json: {
          access_token: 'AT',
          refresh_token: 'RT',
          id_token: idToken('me@example.com'),
        },
      }),
      seen,
    )
    const started = beginHomeComSignIn()
    const out = await completeHomeComSignIn(
      {
        verifier: started.verifier,
        state: started.state,
        callback: `${HOMECOM_REDIRECT_URI}?code=the-code&state=${started.state}`,
      },
      fetchFn,
    )
    expect(out).toEqual({
      token: 'AT',
      refresh: 'RT',
      username: 'me@example.com',
    })
    expect(seen[0]?.url).toBe('https://singlekey-id.com/auth/connect/token')
    expect(seen[0]?.body.get('grant_type')).toBe('authorization_code')
    expect(seen[0]?.body.get('code')).toBe('the-code')
    expect(seen[0]?.body.get('code_verifier')).toBe(started.verifier)
  })

  it('names an already-used or expired code instead of a generic failure', async () => {
    const fetchFn = tokenFetch(() => ({
      status: 400,
      json: { error: 'invalid_grant' },
    }))
    const attempt = completeHomeComSignIn({ verifier: 'v', state: 's', callback: 'abc' }, fetchFn)
    await expect(attempt).rejects.toBeInstanceOf(HomeComLoginError)
    await expect(attempt).rejects.toMatchObject({ reason: 'code-rejected' })
  })
})

describe('HomeCom sign-in wiring', () => {
  it('returns the tokens through secret-typed action outputs', () => {
    const shape = homeComActions.finishSignIn.output.shape
    expect(shape.token.meta()?.secret).toBe(true)
    expect(shape.refresh.meta()?.secret).toBe(true)
  })

  it('accepts signed-in settings without a typed username and keeps the token paste fallback', () => {
    const conn = connectionFromSettings({
      token: 'a',
      refresh: 'b',
      brand: 'bosch',
      region: 'eu',
    })
    expect(conn?.token).toBe('a')
    const fields = buildHomeComFormSchema().sections.flatMap((s) => s.fields)
    const keys = fields.map((f) => f.key)
    expect(keys).toContain('__homecom-sign-in')
    expect(keys).not.toContain('callback')
    expect(keys).not.toContain('verifier')
    const advanced = fields.find((f) => f.key === '__homecom-advanced')
    expect(advanced?.type).toBe('group')
    if (advanced?.type === 'group') {
      expect(advanced.fields.map((f) => f.key)).toEqual(
        expect.arrayContaining(['token', 'refresh', 'gatewayId']),
      )
    }
  })
})
