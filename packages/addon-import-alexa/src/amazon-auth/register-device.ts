/**
 * Device registration: `POST api.<page>/auth/register` turns either an OAuth authorization code
 * (proxy sign-in) or a confirmed code pair (device-code sign-in) into a refresh token, the
 * `mac_dms` key and the first website cookies. {@link completeRegistration} then builds the
 * full registration blob from that.
 *
 * Adapted from alexa-cookie2 (MIT, Copyright (c) Apollon77 and contributors); see
 * assets/alexa-cookie2.LICENSE.md. Codes, tokens and cookies are never logged here.
 */
import { z } from 'zod'
import {
  APP_VERSION,
  DEFAULT_DEVICE_APP_NAME,
  DEVICE_TYPE,
  OS_VERSION,
  USER_AGENT,
} from './constants.js'
import { sanitizeAmazonCookie } from './cookies.js'
import type { AmazonHttp } from './http.js'
import { lookupMarketplacePage } from './token-exchange.js'
import { refreshRegistration, type AlexaRegistration, type RefreshOptions } from './registration.js'

export type RegisterAuth =
  | {
      readonly kind: 'authorization-code'
      readonly authorizationCode: string
      readonly codeVerifier: string
      readonly deviceId: string
    }
  | { readonly kind: 'code-pair'; readonly publicCode: string; readonly privateCode: string }

export interface RegisterInput {
  readonly amazonPage: string
  readonly deviceSerial: string
  readonly frc: string
  readonly auth: RegisterAuth
  readonly deviceAppName?: string
  /** Cookies the sign-in already holds, sent as `website_cookies`. */
  readonly websiteCookies?: ReadonlyArray<{ readonly Name: string; readonly Value: string }>
}

function authData(auth: RegisterAuth): Record<string, unknown> {
  if (auth.kind === 'code-pair') {
    return {
      code_pair: { public_code: auth.publicCode, private_code: auth.privateCode },
      use_global_authentication: 'true',
    }
  }
  return {
    client_id: auth.deviceId,
    authorization_code: auth.authorizationCode,
    code_verifier: auth.codeVerifier,
    code_algorithm: 'SHA-256',
    client_domain: 'DeviceLegacy',
  }
}

/** The one `/auth/register` body both sign-in methods send. */
export function buildRegisterBody(input: RegisterInput): string {
  const appName = input.deviceAppName ?? DEFAULT_DEVICE_APP_NAME
  return JSON.stringify({
    requested_extensions: ['device_info', 'customer_info'],
    cookies: { website_cookies: input.websiteCookies ?? [], domain: `.${input.amazonPage}` },
    registration_data: {
      domain: 'Device',
      app_version: APP_VERSION,
      device_type: DEVICE_TYPE,
      device_name: `%FIRST_NAME%'s%DUPE_STRATEGY_1ST%${appName}`,
      os_version: OS_VERSION,
      device_serial: input.deviceSerial,
      device_model: 'iPhone',
      app_name: appName,
      software_version: '1',
    },
    auth_data: authData(input.auth),
    user_context_map: { frc: input.frc },
    requested_token_type: ['bearer', 'mac_dms', 'website_cookies'],
  })
}

export const RegisterSuccessSchema = z.object({
  response: z.object({
    success: z.object({
      tokens: z.object({
        bearer: z.object({ refresh_token: z.string().min(1).meta({ secret: true }) }),
        website_cookies: z.array(z.object({ Name: z.string(), Value: z.string() })).default([]),
        mac_dms: z.unknown().optional(),
      }),
    }),
  }),
})
export type RegisterTokens = z.infer<typeof RegisterSuccessSchema>['response']['success']['tokens']

const ErrorSchema = z.looseObject({
  response: z.looseObject({
    error: z.looseObject({ code: z.string().optional(), message: z.string().optional() }),
  }),
})

/** The Amazon error code of a refusal, or `unknown`. Never the message: it can echo input. */
export function registerErrorCode(json: unknown): string {
  const parsed = ErrorSchema.safeParse(json)
  return parsed.success ? (parsed.data.response.error.code ?? 'unknown') : 'unknown'
}

export type RegisterOutcome =
  | { readonly kind: 'registered'; readonly tokens: RegisterTokens }
  | { readonly kind: 'refused'; readonly status: number; readonly code: string }

export async function registerDevice(
  input: RegisterInput,
  http: AmazonHttp,
): Promise<RegisterOutcome> {
  const res = await http({
    method: 'POST',
    host: `api.${input.amazonPage}`,
    path: '/auth/register',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US',
      'Accept-Charset': 'utf-8',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-amzn-identity-auth-domain': `api.${input.amazonPage}`,
    },
    body: buildRegisterBody(input),
  })
  const ok = RegisterSuccessSchema.safeParse(res.json)
  if (res.status === 200 && ok.success) {
    return { kind: 'registered', tokens: ok.data.response.success.tokens }
  }
  return { kind: 'refused', status: res.status, code: registerErrorCode(res.json) }
}

/** The `map-md` cookie value the app presents (base64 of a fixed device descriptor). */
export function buildMapMd(): string {
  return Buffer.from(
    JSON.stringify({
      device_user_dictionary: [],
      device_registration_data: { software_version: '1' },
      app_identifier: { app_version: APP_VERSION, bundle_id: 'com.amazon.echo' },
    }),
  ).toString('base64')
}

export interface CompleteInput {
  readonly amazonPage: string
  readonly deviceSerial: string
  readonly frc: string
  readonly mapMd: string
  readonly deviceId?: string
  readonly deviceAppName?: string
  /** Cookies collected during the sign-in itself (proxy flow); empty for the device-code flow. */
  readonly signInCookie?: string
}

/** Registration tokens to the full registration blob: builds the login cookie, then refreshes. */
export async function completeRegistration(
  tokens: RegisterTokens,
  input: CompleteInput,
  http: AmazonHttp,
  options: RefreshOptions = {},
): Promise<AlexaRegistration> {
  const registered = tokens.website_cookies.map((c) => `${c.Name}=${c.Value}`)
  const parts = [`frc=${input.frc}`, `map-md=${input.mapMd}`, ...registered]
  const loginCookie = sanitizeAmazonCookie(
    input.signInCookie !== undefined && input.signInCookie.length > 0
      ? [...parts, input.signInCookie].join('; ')
      : parts.join('; '),
  )
  const amazonPage = await lookupMarketplacePage(
    {
      amazonPage: input.amazonPage,
      cookie: loginCookie,
      acceptLanguage: options.acceptLanguage ?? 'en-US',
    },
    http,
    input.amazonPage,
  )
  return refreshRegistration(
    {
      loginCookie,
      refreshToken: tokens.bearer.refresh_token,
      deviceSerial: input.deviceSerial,
      amazonPage,
      frc: input.frc,
      'map-md': input.mapMd,
      macDms: tokens.mac_dms,
      ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
      deviceAppName: input.deviceAppName ?? DEFAULT_DEVICE_APP_NAME,
    },
    http,
    options,
  )
}
