/**
 * `/api/auth/sso/finish-app` - the native-app leg of an OIDC sign-in (D858).
 *
 * The viewer starts OIDC at `/addon/auth-oidc/<id>/start?app=1&code_challenge=…`
 * and the system browser must come back to the APP, not to the admin UI. The
 * addon parks the app's PKCE challenge, `state`, purpose and return URL in its
 * server-side pending state and signs them into the login bridge (`claims.app`);
 * the callback then lands here instead of `/sso/finish`.
 *
 * Same trust as the web finish (D782, D810): the bridge must verify, be a LOGIN
 * bridge of an enabled provider, be finished in the browser that started it
 * (state-cookie binding) and only once (`jti`); the identity must be LINKED to
 * a user. The difference is the product: NO web session and NO cookie. The hub
 * mints the existing one-shot handoff code - PKCE-bound, state-bound - and
 * redirects the browser to the app's custom scheme:
 *
 *  - `new-session`: the app redeems it at `auth.redeemHandoffCode` for a normal
 *    session;
 *  - `step-up`: the app redeems it at `auth.deviceEnrollProofFromHandoff` for a
 *    device-enroll proof (D855). An IdP login has JUST happened in this request
 *    chain - that is the fresh authentication - and nothing here reads a web
 *    session cookie, so an old session can never launder a proof.
 *
 * Every refusal is a 302 to the app with `error=<code>` (and the app's `state`
 * once the bridge is trusted): the app shows the message, the user is never left
 * on a hub error page. The app's parameters are never logged.
 *
 * Pure: the Fastify route in `sso-routes.ts` wires the deps and maps the outcome.
 */
import {
  APP_FLOW_DEFAULT_REDIRECT,
  appFlowLocation,
  parseAppAuthCallback,
  type SsoBridgeClaimsSchema,
} from '@camstack/types'
import type { z } from 'zod'
import type { AppConfirmations } from './app-confirmations.js'
import { bridgeProviderAddonId } from './auth-provider-gate.js'
import { SessionUserGoneError, type SessionMinter } from './session-mint.js'
import {
  bridgeIsFirstUseHere,
  isLoginBridge,
  oidcIdentityOf,
  type SsoFinishDeps,
} from './sso-finish.js'

type SsoBridgeClaims = z.infer<typeof SsoBridgeClaimsSchema>

/** Refusal codes the app is told (query `error=`). */
export type AppFinishError =
  | 'invalid-bridge'
  | 'not-app-flow'
  | 'link-not-supported'
  | 'provider-disabled'
  | 'sso-state'
  | 'sso-not-linked'
  | 'second-factor-required'
  | 'user-gone'
  | 'failed'

export type SsoFinishAppDeps = Pick<
  SsoFinishDeps,
  | 'verifyBridge'
  | 'isProviderDisabled'
  | 'identities'
  | 'browserBinding'
  | 'consumeBridgeId'
  | 'secondFactors'
  | 'logFailure'
> & {
  readonly minter: Pick<SessionMinter, 'findUser'>
  /** Parks the person's confirmation: the code is minted only after "Continue" (D858). */
  readonly confirmations: Pick<AppConfirmations, 'create'>
  /** A refusal, for the server log: the code only - never the app's parameters. */
  readonly logRefusal?: (error: AppFinishError) => void
}

/**
 * Where the browser goes next: the app's callback (a refusal), or the hub's
 * confirmation page with the one-shot token and the cookie that binds it to
 * THIS browser. No handoff code exists yet in the second case.
 */
export type SsoFinishAppOutcome =
  | { readonly kind: 'app'; readonly location: string }
  | { readonly kind: 'confirm'; readonly token: string; readonly cookie: string }

function refused(
  error: AppFinishError,
  deps: SsoFinishAppDeps,
  redirect: string,
  state: string | undefined,
): SsoFinishAppOutcome {
  deps.logRefusal?.(error)
  return { kind: 'app', location: appFlowLocation(redirect, { error }, state) }
}

/** Exchange a verified app login bridge for a handoff code at the app's callback. */
export async function finishSsoApp(
  bridge: string | undefined,
  deps: SsoFinishAppDeps,
): Promise<SsoFinishAppOutcome> {
  const fallback = APP_FLOW_DEFAULT_REDIRECT
  if (!bridge) return refused('invalid-bridge', deps, fallback, undefined)
  const claims: SsoBridgeClaims | null = deps.verifyBridge(bridge)
  if (claims === null) return refused('invalid-bridge', deps, fallback, undefined)
  const app = claims.app
  if (app === undefined || !isLoginBridge(claims)) {
    return refused('not-app-flow', deps, fallback, undefined)
  }
  // The signed redirect is checked against the allow-list again: the finish
  // never trusts a stored URL to be one it would accept.
  const redirect = parseAppAuthCallback(app.redirect)
  if (redirect === null) return refused('not-app-flow', deps, fallback, undefined)
  const deny = (error: AppFinishError) => refused(error, deps, redirect, app.state)

  if (claims.linkIntent !== undefined) return deny('link-not-supported')
  if (deps.isProviderDisabled(bridgeProviderAddonId(claims.provider))) {
    return deny('provider-disabled')
  }
  if (!bridgeIsFirstUseHere(claims, deps)) return deny('sso-state')
  try {
    const identity = oidcIdentityOf(claims)
    if (identity === null) return deny('invalid-bridge')
    const link = await deps.identities.findUser(identity.provider, identity.subject)
    // A link made under another issuer is not this identity (D782).
    if (link === null || link.issuer !== identity.issuer) return deny('sso-not-linked')
    const record = await deps.minter.findUser(link.userId)
    // Same rule as a password login: the second factors owed are not skippable
    // here, and a browser leg cannot ask for them - the app uses another method.
    if ((await deps.secondFactors(record.id)).length > 0) return deny('second-factor-required')
    // The person has just authenticated; before ANY code exists they confirm
    // that THIS app is the one to sign in (a custom scheme can be claimed by
    // another app, D858).
    const parked = deps.confirmations.create({
      userId: record.id,
      username: record.username,
      app: {
        codeChallenge: app.codeChallenge,
        state: app.state,
        purpose: app.purpose,
        redirect,
        ...(app.lang !== undefined ? { lang: app.lang } : {}),
      },
      authMethod: 'sso',
    })
    return { kind: 'confirm', ...parked }
  } catch (error: unknown) {
    if (error instanceof SessionUserGoneError) return deny('user-gone')
    deps.logFailure?.(error)
    return deny('failed')
  }
}
