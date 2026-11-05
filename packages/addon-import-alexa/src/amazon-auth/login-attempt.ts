/**
 * One Amazon sign-in attempt: the secrets of the request, the cookies Amazon sets while the
 * operator signs in, and the verdict on every upstream response the hub login proxy relays.
 * Amazon's pages are reached directly (the hub proxy dials the real hosts), so nothing here
 * listens on a port.
 *
 * Adapted from alexa-cookie2 (MIT, Copyright (c) Apollon77 and contributors); see
 * assets/alexa-cookie2.LICENSE.md. Only paths and parameter NAMES are ever logged: the
 * authorization code and every cookie value stay out of the log.
 */
import type {
  IScopedLogger,
  LoginProxyResponseView,
  LoginProxyUpstream,
  LoginProxyVerdict,
} from '@camstack/types'
import { describeUrlParams, formatUrlParams } from '../alexa-url-params.js'
import { alexaRegionOptions } from '../alexa-region-options.js'
import { mergeSetCookies, sanitizeAmazonCookie } from './cookies.js'
import {
  buildSignInUrl,
  newOauthAttemptSecrets,
  type OauthAttemptSecrets,
  type RandomBytes,
} from './oauth-request.js'

/** The query parameter Amazon sets on `/ap/maplanding` when it honoured the oa2 request. */
export const AUTHORIZATION_CODE_PARAM = 'openid.oa2.authorization_code'

/** How the Amazon pages ended. */
export type AmazonSignInEnd =
  | { readonly kind: 'authorized'; readonly authorizationCode: string }
  | { readonly kind: 'no_authorization_code' }

export interface AmazonLoginAttemptOptions {
  readonly amazonDomain: string
  readonly sessionId: string
  readonly logger: IScopedLogger
  readonly randomBytes: RandomBytes
}

/** The hosts the hub login proxy may dial for an Amazon sign-in. */
export function amazonUpstreams(amazonDomain: string): readonly LoginProxyUpstream[] {
  const hosts = [`www.${amazonDomain}`, amazonDomain, `alexa.${amazonDomain}`]
  if (amazonDomain !== 'amazon.com') hosts.push('www.amazon.com', 'amazon.com')
  return hosts.map((host) => ({ host, scheme: 'https' }))
}

/** `Location` and request URL of a hop, resolved to absolute URLs. */
function candidateUrls(view: LoginProxyResponseView): readonly URL[] {
  const out: URL[] = []
  for (const raw of [view.location, view.url]) {
    if (raw === null) continue
    try {
      out.push(new URL(raw, view.url))
    } catch {
      // not a URL — ignored
    }
  }
  return out
}

export class AmazonLoginAttempt {
  readonly #o: AmazonLoginAttemptOptions
  readonly secrets: OauthAttemptSecrets
  readonly deviceSerial: string
  #cookie = ''

  constructor(options: AmazonLoginAttemptOptions) {
    this.#o = options
    this.secrets = newOauthAttemptSecrets(options.randomBytes)
    this.deviceSerial = options.randomBytes(16).toString('hex')
  }

  get amazonDomain(): string {
    return this.#o.amazonDomain
  }

  get upstreams(): readonly LoginProxyUpstream[] {
    return amazonUpstreams(this.#o.amazonDomain)
  }

  /** The first URL of the sign-in. */
  get signInUrl(): string {
    return buildSignInUrl({
      amazonDomain: this.#o.amazonDomain,
      deviceId: this.secrets.deviceId,
      codeVerifier: this.secrets.codeVerifier,
      language: alexaRegionOptions(this.#o.amazonDomain).amazonPageProxyLanguage,
    })
  }

  /** The allow-listed cookies Amazon set so far (a secret: never log it). */
  get signInCookie(): string {
    return sanitizeAmazonCookie(this.#cookie)
  }

  /** Called for every upstream response; a terminal verdict ends the attempt. */
  terminal = (view: LoginProxyResponseView): LoginProxyVerdict<AmazonSignInEnd> => {
    this.#cookie = mergeSetCookies(this.#cookie, view.setCookies)
    this.#trace(view)
    for (const url of candidateUrls(view)) {
      if (!url.pathname.endsWith('/ap/maplanding')) continue
      const code = url.searchParams.get(AUTHORIZATION_CODE_PARAM)
      return {
        kind: 'done',
        payload:
          code !== null && code.length > 0
            ? { kind: 'authorized', authorizationCode: code }
            : { kind: 'no_authorization_code' },
      }
    }
    return { kind: 'continue' }
  }

  /** One value-free line per upstream hop (path and parameter names only). */
  #trace(view: LoginProxyResponseView): void {
    const url = describeUrlParams(view.url)
    const landing = url.path.endsWith('/ap/maplanding') ? ' maplanding' : ''
    const location =
      view.location === null
        ? 'none'
        : `${describeUrlParams(view.location).path} ${formatUrlParams(view.location)}`
    this.#o.logger.info(
      `[alexa-login-trace] hop${landing} status=${view.status} url=${url.path} ${formatUrlParams(view.url)} location=${location}`,
      { meta: { sessionId: this.#o.sessionId } },
    )
  }
}
