import { describe, expect, it } from 'vitest'
import { probeGoogleAccount } from '../google-connection-probe.js'
import { GOOGLE_CALENDAR_LIST_URL } from '../google-types.js'

function calendarOkFetch(): typeof fetch {
  return (async (url: string | URL) => {
    expect(String(url)).toBe(GOOGLE_CALENDAR_LIST_URL)
    return { ok: true, status: 200, text: async () => '{}' } as Response
  }) as typeof fetch
}

describe('probeGoogleAccount — the real Test behind a signed-in Google account', () => {
  it('reports Gmail send scope granted when the refreshed token carries it', async () => {
    const result = await probeGoogleAccount({
      ensureAccessToken: async () => 'token',
      grantedScopes: () =>
        'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.send',
      fetch: calendarOkFetch(),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.detail).toMatch(/Gmail send scope granted/)
  })

  // Discriminates the planning#543 bug: an account connected before gmail.send was requested
  // (or that denied it) reads the Calendar probe as success and told the operator nothing about
  // email. Without the scope check this assertion fails on the old behaviour (detail undefined).
  it('flags a missing Gmail send scope instead of silently passing', async () => {
    const result = await probeGoogleAccount({
      ensureAccessToken: async () => 'token',
      grantedScopes: () => 'https://www.googleapis.com/auth/calendar.readonly',
      fetch: calendarOkFetch(),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.detail).toMatch(/Gmail send scope NOT granted/)
  })

  it('treats an unknown (empty) granted-scopes string as Gmail send NOT granted', async () => {
    const result = await probeGoogleAccount({
      ensureAccessToken: async () => 'token',
      grantedScopes: () => '',
      fetch: calendarOkFetch(),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.detail).toMatch(/NOT granted/)
  })

  it('fails when the refresh leaves an empty access token', async () => {
    const result = await probeGoogleAccount({
      ensureAccessToken: async () => '',
      grantedScopes: () => '',
    })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Sign in again/) })
  })

  it('retries once on a 401 (stale cached token) before failing', async () => {
    let calls = 0
    const fetchMock: typeof fetch = (async () => {
      calls += 1
      if (calls === 1) return { ok: false, status: 401, text: async () => '' } as Response
      return { ok: true, status: 200, text: async () => '{}' } as Response
    }) as typeof fetch
    let refreshCalls = 0
    const result = await probeGoogleAccount({
      ensureAccessToken: async () => {
        refreshCalls += 1
        return 'token'
      },
      grantedScopes: () => 'https://www.googleapis.com/auth/gmail.send',
      fetch: fetchMock,
    })
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
    expect(refreshCalls).toBe(2)
  })

  it('fails with the Calendar error when the remote refuses after the retry', async () => {
    const fetchMock: typeof fetch = (async () =>
      ({
        ok: false,
        status: 403,
        text: async () => 'insufficient scope',
      }) as Response) as typeof fetch
    const result = await probeGoogleAccount({
      ensureAccessToken: async () => 'token',
      grantedScopes: () => '',
      fetch: fetchMock,
    })
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Google Calendar probe failed \(403\)/),
    })
  })
})
