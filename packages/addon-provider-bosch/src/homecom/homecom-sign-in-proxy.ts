import type { VendorLoginProxy } from '@camstack/types'
import { createSignInClaims, openSignInProxy } from '../shared/login-proxy-sign-in.js'
import { HOMECOM_REDIRECT_URI } from './homecom-oauth.js'
import {
  finishHomeComSignIn,
  homeComSignInAttempts,
  publishHomeComSignIn,
  type HomeComFinishedSignIn,
  type HomeComPublishedSignIn,
} from './homecom-sign-in.js'
import type { FetchFn } from './homecom-api-client.js'

/** SingleKey ID serves the whole HomeCom login. (Not verified against the live pages: no vendor credentials.) */
export const HOMECOM_LOGIN_HOSTS: readonly string[] = ['singlekey-id.com']

export const HOMECOM_PROXY_PREFIX = 'login'

export const HOMECOM_APP_SCHEME = HOMECOM_REDIRECT_URI.slice(
  0,
  HOMECOM_REDIRECT_URI.indexOf('://') + 3,
)

export const homeComSignInClaims = createSignInClaims<HomeComFinishedSignIn>()

export interface HomeComProxiedSignInDeps {
  /** Null when the hub's data plane is not serving the proxy: the paste path still works. */
  readonly proxy: VendorLoginProxy | null
  readonly addonId: string
  readonly nowMs?: () => number
  readonly fetchFn?: FetchFn
}

/** Start an attempt whose `authorizeUrl` is the hub-relative proxied login page. */
export function beginHomeComProxiedSignIn(deps: HomeComProxiedSignInDeps): HomeComPublishedSignIn {
  const nowMs = deps.nowMs ?? ((): number => Date.now())
  const published = publishHomeComSignIn(homeComSignInAttempts, nowMs())
  if (deps.proxy === null) return published
  const entry = openSignInProxy<HomeComFinishedSignIn>({
    proxy: deps.proxy,
    claims: homeComSignInClaims,
    addonId: deps.addonId,
    attemptId: published.attemptId,
    authorizeUrl: published.authorizeUrl,
    hosts: HOMECOM_LOGIN_HOSTS,
    appScheme: HOMECOM_APP_SCHEME,
    finish: (callback) =>
      finishHomeComSignIn(
        { attemptId: published.attemptId, callback, nowMs: nowMs() },
        homeComSignInAttempts,
        deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {},
      ),
    nowMs,
  })
  return { attemptId: published.attemptId, authorizeUrl: entry }
}
