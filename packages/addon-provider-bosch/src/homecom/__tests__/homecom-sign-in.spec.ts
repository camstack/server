import { SECRET_CLEAR } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { HOMECOM_REDIRECT_URI } from '../homecom-oauth.js'
import {
  homeComGatewayCount,
  homeComSignOutPatch,
  homeComSignedInAccount,
} from '../homecom-account-status.js'
import { HomeComLoginError } from '../homecom-login.js'
import { finishHomeComSignIn, publishHomeComSignIn } from '../homecom-sign-in.js'
import { createSignInAttemptStore, SIGN_IN_ATTEMPT_TTL_MS } from '../../shared/sign-in-attempt.js'
import type { FetchFn } from '../homecom-api-client.js'
import type { HomeComGatewayListing } from '../homecom-api-client.js'

function idToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url')
  return `e30.${payload}.sig`
}

function tokenFetch(seen: { verifier: string }[]): FetchFn {
  return async (_url, init) => {
    const body = new URLSearchParams(init?.body ?? '')
    seen.push({ verifier: body.get('code_verifier') ?? '' })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'access',
        refresh_token: 'refresh',
        id_token: idToken('me@example.com'),
      }),
    }
  }
}

function callbackFor(authorizeUrl: string, code = 'abc'): string {
  const state = new URL(authorizeUrl).searchParams.get('state')
  return `${HOMECOM_REDIRECT_URI}?code=${code}&state=${state}`
}

describe('publishHomeComSignIn', () => {
  it('keeps the verifier and the state off the result the form receives', () => {
    const store = createSignInAttemptStore()
    const published = publishHomeComSignIn(store, 1_000)
    expect(published.attemptId.length).toBeGreaterThan(0)
    expect(published.authorizeUrl.startsWith('https://singlekey-id.com/')).toBe(true)
    expect(published).not.toHaveProperty('verifier')
    expect(published).not.toHaveProperty('state')
    expect(new URL(published.authorizeUrl).searchParams.get('code_verifier')).toBeNull()
  })
})

describe('finishHomeComSignIn', () => {
  it('completes a pasted address with the verifier kept on the server', async () => {
    const store = createSignInAttemptStore()
    const published = publishHomeComSignIn(store, 1_000)
    const seen: { verifier: string }[] = []
    const finished = await finishHomeComSignIn(
      {
        attemptId: published.attemptId,
        callback: callbackFor(published.authorizeUrl),
        nowMs: 1_000,
      },
      store,
      {
        fetchFn: tokenFetch(seen),
        listGateways: async () => [{ gatewayId: 'gw-1', name: 'Home' }],
      },
    )
    expect(seen[0]?.verifier.length).toBeGreaterThan(0)
    expect(published.authorizeUrl.includes(seen[0]?.verifier ?? 'missing')).toBe(false)
    expect(finished.token).toBe('access')
    expect(finished.accountLabel).toBe('me@example.com')
    expect(finished.gatewayId).toBe('gw-1')
    expect(finished.brand).toBe('bosch')
    expect(finished.region).toBe('eu')
    expect(finished.gatewayCount).toBe(1)
    expect(finished).not.toHaveProperty('choices')
  })

  it('keeps the sign-in when the gateway list fails', async () => {
    const store = createSignInAttemptStore()
    const published = publishHomeComSignIn(store, 1_000)
    const finished = await finishHomeComSignIn(
      {
        attemptId: published.attemptId,
        callback: callbackFor(published.authorizeUrl),
        nowMs: 1_000,
      },
      store,
      {
        fetchFn: tokenFetch([]),
        listGateways: async () => {
          throw new Error('offline')
        },
      },
    )
    expect(finished.token).toBe('access')
    expect(finished.gatewayId).toBeUndefined()
    expect(finished.summary).toContain('could not be read')
  })

  it('offers a choice when the account has several gateways and does not pick one', async () => {
    const store = createSignInAttemptStore()
    const published = publishHomeComSignIn(store, 1_000)
    const gateways: HomeComGatewayListing[] = [
      { gatewayId: 'gw-1', name: 'Home', brand: 'bosch', region: 'eu' },
      { gatewayId: 'gw-2', name: 'Cabin', brand: 'buderus', region: 'us' },
    ]
    const finished = await finishHomeComSignIn(
      {
        attemptId: published.attemptId,
        callback: callbackFor(published.authorizeUrl),
        nowMs: 1_000,
      },
      store,
      { fetchFn: tokenFetch([]), listGateways: async () => gateways },
    )
    expect(finished.gatewayId).toBeUndefined()
    expect(finished.gatewayCount).toBe(2)
    expect(finished.choices).toEqual([
      { value: 'gw-1', label: 'Home', brand: 'bosch', region: 'eu' },
      { value: 'gw-2', label: 'Cabin', brand: 'buderus', region: 'us' },
    ])
  })

  it('maps a missing attempt, an expired attempt, a mismatched state and a denial', async () => {
    const store = createSignInAttemptStore()
    const published = publishHomeComSignIn(store, 0)
    const denied = finishHomeComSignIn(
      {
        attemptId: published.attemptId,
        callback: `${HOMECOM_REDIRECT_URI}?error=access_denied&state=${new URL(published.authorizeUrl).searchParams.get('state')}`,
        nowMs: 1,
      },
      store,
      { fetchFn: tokenFetch([]) },
    )
    await expect(denied).rejects.toMatchObject({ reason: 'denied' })

    const again = publishHomeComSignIn(store, 0)
    const mismatched = finishHomeComSignIn(
      {
        attemptId: again.attemptId,
        callback: `${HOMECOM_REDIRECT_URI}?code=abc&state=other`,
        nowMs: 1,
      },
      store,
      { fetchFn: tokenFetch([]) },
    )
    await expect(mismatched).rejects.toMatchObject({ reason: 'state-mismatch' })

    const expiredStart = publishHomeComSignIn(store, 0)
    const expired = finishHomeComSignIn(
      {
        attemptId: expiredStart.attemptId,
        callback: callbackFor(expiredStart.authorizeUrl),
        nowMs: SIGN_IN_ATTEMPT_TTL_MS + 1,
      },
      store,
      { fetchFn: tokenFetch([]) },
    )
    await expect(expired).rejects.toBeInstanceOf(HomeComLoginError)
    await expect(expired).rejects.toMatchObject({ reason: 'code-rejected' })

    const reused = publishHomeComSignIn(store, 10)
    await finishHomeComSignIn(
      { attemptId: reused.attemptId, callback: callbackFor(reused.authorizeUrl), nowMs: 10 },
      store,
      { fetchFn: tokenFetch([]), listGateways: async () => [] },
    )
    const second = finishHomeComSignIn(
      { attemptId: reused.attemptId, callback: callbackFor(reused.authorizeUrl), nowMs: 11 },
      store,
      { fetchFn: tokenFetch([]) },
    )
    await expect(second).rejects.toMatchObject({ reason: 'state-mismatch' })
  })
})

describe('homeCom sign-out', () => {
  it('clears secrets with the keychain clear instruction and reads a stored label', () => {
    expect(homeComSignOutPatch()).toEqual({
      token: SECRET_CLEAR,
      refresh: SECRET_CLEAR,
      username: SECRET_CLEAR,
      accountLabel: '',
      gatewayId: '',
      gatewayCount: 0,
    })
    expect(homeComSignedInAccount({ accountLabel: 'me@example.com' })).toBe('me@example.com')
    expect(homeComSignedInAccount({ username: 'old@example.com' })).toBe('old@example.com')
    expect(homeComSignedInAccount({ username: { $secret: true } })).toBe('')
    expect(homeComGatewayCount({})).toBeNull()
    expect(homeComGatewayCount({ gatewayCount: 2 })).toBe(2)
  })
})
