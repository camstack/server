/**
 * The sign-in request the Alexa app opens: an OpenID `checkid_setup` carrying an OAuth2
 * `oa2` extension (device client id, `device_auth_access` scope, PKCE S256). Pure: every
 * random value is injected so the output is reproducible.
 *
 * Adapted from alexa-cookie2 (MIT, Copyright (c) Apollon77 and contributors); see
 * assets/alexa-cookie2.LICENSE.md.
 */
import { createHash } from 'node:crypto'
import { buildMapMd } from './register-device.js'

/** Random bytes source; `crypto.randomBytes` in production. */
export type RandomBytes = (size: number) => Buffer

/** The id suffix Amazon expects on a device id: hex of the ASCII device type tag. */
const DEVICE_ID_SUFFIX = '23413249564c5635564d32573831'
const FRC_BYTES = 313

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/** The code challenge of a PKCE S256 verifier. */
export function pkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

/** Amazon's handle suffix: `_it` for amazon.it, `_uk` for amazon.co.uk, none for amazon.com. */
export function assocHandleSuffix(amazonDomain: string): string {
  const tld = amazonDomain.slice(amazonDomain.lastIndexOf('.') + 1)
  return tld === 'com' ? '' : `_${tld}`
}

export interface OauthAttemptSecrets {
  readonly codeVerifier: string
  readonly deviceId: string
  readonly frc: string
  readonly mapMd: string
}

/** The per-attempt secrets: PKCE verifier, device id, `frc` and `map-md`. */
export function newOauthAttemptSecrets(randomBytes: RandomBytes): OauthAttemptSecrets {
  const verifier = base64Url(randomBytes(32))
  const hex = randomBytes(16).toString('hex').toUpperCase()
  return {
    codeVerifier: verifier,
    deviceId: `${Buffer.from(hex).toString('hex')}${DEVICE_ID_SUFFIX}`,
    frc: randomBytes(FRC_BYTES).toString('base64'),
    mapMd: buildMapMd(),
  }
}

export interface OauthRequestInput {
  readonly amazonDomain: string
  readonly deviceId: string
  readonly codeVerifier: string
  /** The Amazon `language=` value, e.g. `it_IT`. */
  readonly language: string
}

/** The `/ap/signin` URL the sign-in starts from. */
export function buildSignInUrl(input: OauthRequestInput): string {
  const base = input.amazonDomain
  const handle = `amzn_dp_project_dee_ios${assocHandleSuffix(base)}`
  const params = new URLSearchParams([
    ['openid.return_to', `https://www.${base}/ap/maplanding`],
    ['openid.assoc_handle', handle],
    ['openid.identity', 'http://specs.openid.net/auth/2.0/identifier_select'],
    ['pageId', handle],
    ['accountStatusPolicy', 'P1'],
    ['openid.claimed_id', 'http://specs.openid.net/auth/2.0/identifier_select'],
    ['openid.mode', 'checkid_setup'],
    ['openid.ns.oa2', `http://www.${base}/ap/ext/oauth/2`],
    ['openid.oa2.client_id', `device:${input.deviceId}`],
    ['openid.ns.pape', 'http://specs.openid.net/extensions/pape/1.0'],
    ['openid.oa2.response_type', 'code'],
    ['openid.ns', 'http://specs.openid.net/auth/2.0'],
    ['openid.pape.max_auth_age', '0'],
    ['openid.oa2.scope', 'device_auth_access'],
    ['openid.oa2.code_challenge_method', 'S256'],
    ['openid.oa2.code_challenge', pkceChallenge(input.codeVerifier)],
    ['language', input.language],
  ])
  return `https://www.${base}/ap/signin?${params.toString()}`
}
