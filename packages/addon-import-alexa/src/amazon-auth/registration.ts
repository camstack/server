/**
 * The registration blob of an Alexa account: the device Amazon registered, its refresh token
 * and the cookie plus csrf the Alexa web API needs. The shape is exactly alexa-cookie2's
 * `dataVersion: 2` object, so `alexa-remote2` keeps accepting it and a record stored by an
 * earlier version needs no new sign-in.
 *
 * Adapted from alexa-cookie2 (MIT, Copyright (c) Apollon77 and contributors); see
 * assets/alexa-cookie2.LICENSE.md.
 */
import { z } from 'zod'
import type { AmazonHttp } from './http.js'
import { LEGACY_DEVICE_APP_NAME } from './constants.js'
import {
  exchangeForCookies,
  fetchAccessToken,
  probeCsrf,
  registerCapabilities,
} from './token-exchange.js'
import { parseCookieHeader, sanitizeAmazonCookie, serializeCookies } from './cookies.js'

/** What a registration needs before its cookie and csrf are (re)built. */
export const AlexaRegistrationSeedSchema = z.looseObject({
  refreshToken: z.string().min(1).meta({ secret: true }),
  loginCookie: z.string().min(1).meta({ secret: true }),
  deviceSerial: z.string().min(1),
  amazonPage: z.string().min(1),
  deviceId: z.string().optional(),
  frc: z.string().optional(),
  'map-md': z.string().optional(),
  macDms: z.unknown().optional(),
  deviceAppName: z.string().optional(),
  accessToken: z.string().optional().meta({ secret: true }),
  tokenDate: z.number().optional(),
})
export type AlexaRegistrationSeed = z.infer<typeof AlexaRegistrationSeedSchema>

/** The complete blob. Loose: fields a later alexa-remote2 adds are carried through. */
export const AlexaRegistrationSchema = AlexaRegistrationSeedSchema.extend({
  localCookie: z.string().min(1).meta({ secret: true }),
  csrf: z.string().min(1),
  dataVersion: z.number().optional(),
})
export type AlexaRegistration = z.infer<typeof AlexaRegistrationSchema>

/** The `dataVersion` alexa-remote2 requires before it trusts a stored blob without a refresh. */
export const REGISTRATION_DATA_VERSION = 2

/** A stored registration in any of the forms the record holds it: the object, or its JSON text. */
export function parseRegistration(value: unknown): AlexaRegistration | null {
  const candidate: unknown = typeof value === 'string' ? safeJson(value) : value
  const parsed = AlexaRegistrationSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

function safeJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

export interface RefreshOptions {
  readonly now?: () => number
  /** The `Accept-Language` Amazon should answer in, e.g. `it-IT`. */
  readonly acceptLanguage?: string
}

/**
 * Exchange the refresh token for a fresh access token, then rebuild the website cookie and its
 * csrf. Throws `AmazonAuthRejectedError` when Amazon refuses the token (the account must
 * sign in again); any other failure is a plain `Error` (retry later).
 */
export async function refreshRegistration(
  registration: AlexaRegistrationSeed,
  http: AmazonHttp,
  options: RefreshOptions = {},
): Promise<AlexaRegistration> {
  const now = options.now ?? Date.now
  const acceptLanguage = options.acceptLanguage ?? 'en-US'
  const amazonPage = registration.amazonPage
  const deviceAppName = registration.deviceAppName ?? LEGACY_DEVICE_APP_NAME

  const accessToken = await fetchAccessToken(
    {
      amazonPage,
      refreshToken: registration.refreshToken,
      loginCookie: registration.loginCookie,
      deviceAppName,
      acceptLanguage,
    },
    http,
  )
  await registerCapabilities({ accessToken, acceptLanguage }, http)

  const cookieJar = await exchangeForCookies(
    {
      amazonPage,
      refreshToken: registration.refreshToken,
      deviceAppName,
      acceptLanguage,
    },
    http,
  )
  const frontCookies = parseCookieHeader(registration.loginCookie)
  const rebuilt = new Map<string, string>()
  for (const name of ['frc', 'map-md']) {
    const value = frontCookies.get(name)
    if (value !== undefined) rebuilt.set(name, value)
  }
  for (const [name, value] of parseCookieHeader(cookieJar)) rebuilt.set(name, value)
  const loginCookie = sanitizeAmazonCookie(serializeCookies(rebuilt))

  const probed = await probeCsrf({ amazonPage, cookie: cookieJar }, http)
  return {
    ...registration,
    accessToken,
    loginCookie,
    localCookie: probed.cookie,
    csrf: probed.csrf,
    amazonPage,
    deviceAppName,
    tokenDate: now(),
    dataVersion: REGISTRATION_DATA_VERSION,
  }
}
