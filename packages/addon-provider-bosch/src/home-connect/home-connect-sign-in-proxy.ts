import type { VendorLoginProxy } from '@camstack/types'
import { createSignInClaims, openSignInProxy } from '../shared/login-proxy-sign-in.js'
import {
  finishHomeConnectSignIn,
  homeConnectSignInAttempts,
  HOME_CONNECT_REDIRECT_URI,
  publishHomeConnectSignIn,
  type HomeConnectPublishedSignIn,
  type LoginFetch,
} from './home-connect-login.js'
import {
  homeConnectFinishResult,
  type HomeConnectFinishResult,
} from './home-connect-sign-in-result.js'

/**
 * Home Connect signs in through its own identity pages, which end on `hcauth://auth/prod?...`
 * — an address no browser can open. These are the hosts those pages are served from; the
 * proxy reaches nothing else. (Not verified against the live pages: no vendor credentials.)
 */
export const HOME_CONNECT_LOGIN_HOSTS: readonly string[] = [
  'api.home-connect.com',
  'singlekey-id.com',
]

export const HOME_CONNECT_APP_SCHEME = HOME_CONNECT_REDIRECT_URI.slice(
  0,
  HOME_CONNECT_REDIRECT_URI.indexOf('://') + 3,
)

export const homeConnectSignInClaims = createSignInClaims<HomeConnectFinishResult>()

export interface HomeConnectProxiedSignInDeps {
  /** Null when the hub's data plane is not serving the proxy: the paste path still works. */
  readonly proxy: VendorLoginProxy | null
  readonly addonId: string
  readonly nowMs?: () => number
  readonly fetchImpl?: LoginFetch
}

/** Start an attempt whose `authorizeUrl` is the hub-relative proxied login page. */
export function beginHomeConnectProxiedSignIn(
  deps: HomeConnectProxiedSignInDeps,
): HomeConnectPublishedSignIn {
  const nowMs = deps.nowMs ?? ((): number => Date.now())
  const published = publishHomeConnectSignIn(homeConnectSignInAttempts, nowMs())
  if (deps.proxy === null) return published
  const entry = openSignInProxy<HomeConnectFinishResult>({
    proxy: deps.proxy,
    claims: homeConnectSignInClaims,
    addonId: deps.addonId,
    attemptId: published.attemptId,
    authorizeUrl: published.authorizeUrl,
    hosts: HOME_CONNECT_LOGIN_HOSTS,
    appScheme: HOME_CONNECT_APP_SCHEME,
    finish: async (callback) =>
      homeConnectFinishResult(
        await finishHomeConnectSignIn(
          { attemptId: published.attemptId, callback, nowMs: nowMs() },
          homeConnectSignInAttempts,
          deps.fetchImpl,
        ),
      ),
    nowMs,
  })
  return { attemptId: published.attemptId, authorizeUrl: entry }
}
