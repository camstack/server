import { describe, expect, it } from 'vitest'
import {
  applyTokenResponse,
  buildAuthorizeUrl,
  exchangeCode,
  needsRefresh,
  probeGoogleOauthClient,
  refreshAccessToken,
} from '../google-oauth.js'
import { DEFAULT_OAUTH_STATE } from '../google-types.js'

function asParams(body: unknown): URLSearchParams {
  if (!(body instanceof URLSearchParams)) {
    throw new Error('expected URLSearchParams body')
  }
  return body
}

describe('google oauth', () => {
  const cfg = {
    clientId: 'cid',
    clientSecret: 'sec',
    redirectUri: 'https://hub.example/addon/google-services/oauth/callback',
  }

  it('buildAuthorizeUrl requests offline calendar.readonly and gmail.send', () => {
    const url = buildAuthorizeUrl(cfg, 'state-1')
    const u = new URL(url)
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('prompt')).toBe('consent')
    const scope = u.searchParams.get('scope') ?? ''
    expect(scope).toContain('calendar.readonly')
    expect(scope).toContain('gmail.send')
    expect(u.searchParams.get('state')).toBe('state-1')
  })

  it('applyTokenResponse persists refresh token from exchange', () => {
    const next = applyTokenResponse(
      DEFAULT_OAUTH_STATE,
      {
        access_token: 'at',
        expires_in: 3600,
        refresh_token: 'rt-new',
      },
      1_000_000,
    )
    expect(next.refreshToken).toBe('rt-new')
    expect(next.accessToken).toBe('at')
    expect(next.accessExpiresAt).toBe(1_000_000 + 3540_000)
  })

  it('applyTokenResponse keeps prior refresh when refresh response omits it', () => {
    const prev = { ...DEFAULT_OAUTH_STATE, refreshToken: 'rt-keep', accessToken: 'old' }
    const next = applyTokenResponse(prev, { access_token: 'at2', expires_in: 3600 }, 2_000_000)
    expect(next.refreshToken).toBe('rt-keep')
    expect(next.accessToken).toBe('at2')
  })

  it('needsRefresh is true when access is expired and refresh exists', () => {
    expect(
      needsRefresh(
        { ...DEFAULT_OAUTH_STATE, refreshToken: 'rt', accessToken: 'a', accessExpiresAt: 10 },
        20,
      ),
    ).toBe(true)
    expect(
      needsRefresh(
        { ...DEFAULT_OAUTH_STATE, refreshToken: 'rt', accessToken: 'a', accessExpiresAt: 100 },
        20,
      ),
    ).toBe(false)
  })

  it('refreshAccessToken posts grant_type=refresh_token', async () => {
    let captured: URLSearchParams | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      captured = asParams(init?.body ?? null)
      return {
        ok: true,
        json: async () => ({ access_token: 'new', expires_in: 3600 }),
      } as Response
    }
    const tokens = await refreshAccessToken(cfg, 'rt', { fetch: fetchMock })
    expect(tokens.access_token).toBe('new')
    expect(captured!.get('grant_type')).toBe('refresh_token')
    expect(captured!.get('refresh_token')).toBe('rt')
  })

  it('exchangeCode posts authorization_code', async () => {
    let captured: URLSearchParams | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      captured = asParams(init?.body ?? null)
      return {
        ok: true,
        json: async () => ({
          access_token: 'at',
          expires_in: 3600,
          refresh_token: 'rt',
        }),
      } as Response
    }
    const tokens = await exchangeCode(cfg, 'the-code', { fetch: fetchMock })
    expect(tokens.refresh_token).toBe('rt')
    expect(captured!.get('grant_type')).toBe('authorization_code')
    expect(captured!.get('code')).toBe('the-code')
  })

  it('probeGoogleOauthClient fails on invalid_client', async () => {
    const fetchMock: typeof fetch = async () =>
      ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: 'invalid_client' }),
      }) as Response
    const result = await probeGoogleOauthClient(cfg, { fetch: fetchMock })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Invalid Client ID|rejected/i)
  })

  it('probeGoogleOauthClient succeeds on invalid_grant (client accepted)', async () => {
    const fetchMock: typeof fetch = async () =>
      ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant' }),
      }) as Response
    const result = await probeGoogleOauthClient(cfg, { fetch: fetchMock })
    expect(result.ok).toBe(true)
  })
})
