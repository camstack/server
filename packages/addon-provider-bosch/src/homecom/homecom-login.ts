import { createHash, randomBytes } from 'node:crypto'
import { parseOAuthCallback } from '../shared/oauth-callback.js'
import type { FetchFn } from './homecom-api-client.js'
import {
  HOMECOM_AUTHORIZE_URL,
  HOMECOM_CLIENT_ID,
  HOMECOM_REDIRECT_URI,
  HOMECOM_SCOPE,
  HOMECOM_TOKEN_URL,
} from './homecom-oauth.js'

export { HOMECOM_REDIRECT_URI } from './homecom-oauth.js'

export type HomeComLoginFailure =
  | 'empty'
  | 'no-code'
  | 'state-missing'
  | 'state-mismatch'
  | 'denied'
  | 'code-rejected'
  | 'rejected'
  | 'no-refresh'

const MESSAGES: Readonly<Record<HomeComLoginFailure, string>> = {
  empty: 'Nothing was pasted. Paste the address the browser tried to open after you signed in.',
  'no-code':
    'No sign-in code was found in what you pasted. Copy the whole address that starts with com.bosch.tt.dashtt.pointt://, or just the code.',
  'state-missing':
    'The pasted address has no state. Copy the complete address, or create the login link again.',
  'state-mismatch':
    'This address belongs to a different sign-in attempt. Create the login link again and use the address that follows it.',
  denied: 'Bosch refused the sign-in. Create the login link again and approve the access.',
  'code-rejected':
    'The code was already used or has expired. Create the login link again; a code works once and only for a few minutes.',
  rejected: 'Bosch did not accept the sign-in. Create the login link again.',
  'no-refresh':
    'Bosch signed you in but returned no long-lived token. Create the login link again.',
}

/** A failure the operator can act on; `reason` is stable, the message is for the form. */
export class HomeComLoginError extends Error {
  readonly name = 'HomeComLoginError'
  readonly reason: HomeComLoginFailure
  constructor(reason: HomeComLoginFailure) {
    super(MESSAGES[reason])
    this.reason = reason
  }
}

export interface HomeComSignInStart {
  readonly authorizeUrl: string
  readonly verifier: string
  readonly state: string
}

export interface HomeComSignInTokens {
  readonly token: string
  readonly refresh: string
  readonly username: string
}

function b64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

export function beginHomeComSignIn(): HomeComSignInStart {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  const url = new URL(HOMECOM_AUTHORIZE_URL)
  url.searchParams.set('client_id', HOMECOM_CLIENT_ID)
  url.searchParams.set('redirect_uri', HOMECOM_REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', HOMECOM_SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', b64url(randomBytes(16)))
  url.searchParams.set('prompt', 'login')
  return { authorizeUrl: url.toString(), verifier, state }
}

/**
 * The sign-in code from whatever the operator pasted: the full app address, an address copied
 * from the browser's developer tools, a bare `code=…&state=…` query, or the bare code.
 */
export function parseHomeComCallback(input: string, expectedState: string): string {
  const parsed = parseOAuthCallback(input, expectedState)
  if (!parsed.ok) throw new HomeComLoginError(parsed.reason)
  return parsed.code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emailFromIdToken(idToken: unknown): string {
  if (typeof idToken !== 'string') return ''
  const payload = idToken.split('.')[1]
  if (!payload) return ''
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return isRecord(parsed) && typeof parsed['email'] === 'string' ? parsed['email'] : ''
  } catch {
    return ''
  }
}

export async function completeHomeComSignIn(
  input: {
    readonly verifier: string
    readonly callback: string
    readonly state: string
  },
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<HomeComSignInTokens> {
  const code = parseHomeComCallback(input.callback, input.state)
  const res = await fetchFn(HOMECOM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: HOMECOM_CLIENT_ID,
      code,
      code_verifier: input.verifier,
      redirect_uri: HOMECOM_REDIRECT_URI,
    }).toString(),
  })
  const body: unknown = await res.json().catch((): null => null)
  if (!res.ok) {
    const error = isRecord(body) ? body['error'] : undefined
    throw new HomeComLoginError(error === 'invalid_grant' ? 'code-rejected' : 'rejected')
  }
  if (!isRecord(body) || typeof body['access_token'] !== 'string' || body['access_token'] === '') {
    throw new HomeComLoginError('rejected')
  }
  const refresh = body['refresh_token']
  if (typeof refresh !== 'string' || refresh === '') throw new HomeComLoginError('no-refresh')
  return {
    token: body['access_token'],
    refresh,
    username: emailFromIdToken(body['id_token']),
  }
}
