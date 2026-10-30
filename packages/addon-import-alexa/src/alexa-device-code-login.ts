import { randomBytes } from 'node:crypto'
import https from 'node:https'
import alexaCookie from 'alexa-cookie2'
import { z } from 'zod'
import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  AlexaCapturedCookie,
  AlexaProxyLoginPhase,
  AlexaProxyLoginStatus,
} from './alexa-proxy-login.js'
import { alexaRegionOptions } from './alexa-region-options.js'

/**
 * Amazon's DEVICE-CODE sign-in for the Alexa broker. It avoids every Amazon sign-in page
 * (so it does not depend on the OAuth redirect the proxied login needs):
 *
 *   1. `POST api.<domain>/auth/create/codepair` → a short public code + a private one;
 *   2. the operator opens `https://www.<domain>/code` on ANY device, signs in and types the code;
 *   3. we poll `/auth/register` with the code pair — HTTP 401 until the operator confirmed;
 *   4. the registration returns a refresh token + website cookies; alexa-cookie2's own
 *      `refreshAlexaCookie` turns them into the cookie + csrf;
 *   5. the result is the SAME `cookieData` blob the proxy login captures (refresh token,
 *      macDms, deviceSerial, localCookie, csrf, amazonPage …), so commit and the broker's
 *      auto-refresh are unchanged.
 *
 * The private code, tokens and cookies never reach a status, a log line or an error.
 */

const APP_VERSION = '2.2.651540.0'
const OS_VERSION = '18.3.1'
const USER_AGENT = `AmazonWebView/Amazon Alexa/${APP_VERSION}/iOS/${OS_VERSION}/iPhone`
/** The Alexa app device type the code pair registers as. */
const DEVICE_TYPE = 'A2IVLV5VM2W81'
const DEFAULT_EXPIRES_S = 600
const DEFAULT_POLL_S = 5

/** One HTTPS call to Amazon. Injected so tests never touch the network. */
export interface DeviceCodeHttpRequest {
  readonly host: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}
export interface DeviceCodeHttpResponse {
  readonly status: number
  /** The parsed JSON body, or null when it was not JSON. */
  readonly json: unknown
}
export type DeviceCodeHttp = (req: DeviceCodeHttpRequest) => Promise<DeviceCodeHttpResponse>

/** The registration object alexa-cookie2 hands back; the whole object is kept as `cookieData`. */
const RefreshedSchema = z.looseObject({ localCookie: z.string().min(1), csrf: z.string().min(1) })
export type DeviceCodeRefreshInput = Parameters<typeof alexaCookie.refreshAlexaCookie>[0]
export type DeviceCodeRefresh = (input: DeviceCodeRefreshInput) => Promise<unknown>

const CodepairSchema = z.object({
  public_code: z.string().min(1),
  private_code: z.string().min(1),
  expires_in: z.coerce.number().positive().optional(),
  polling_interval_in_seconds: z.coerce.number().positive().optional(),
})
const RegisterSuccessSchema = z.object({
  response: z.object({
    success: z.object({
      tokens: z.object({
        bearer: z.object({ refresh_token: z.string().min(1) }),
        website_cookies: z.array(z.object({ Name: z.string(), Value: z.string() })).default([]),
        mac_dms: z.unknown().optional(),
      }),
    }),
  }),
})

export const defaultDeviceCodeHttp: DeviceCodeHttp = (req) =>
  new Promise<DeviceCodeHttpResponse>((resolve, reject) => {
    const r = https.request(
      { host: req.host, path: req.path, method: 'POST', headers: req.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            // not JSON — the status still tells the story
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.setTimeout(20_000, () => r.destroy(new Error('timeout')))
    r.on('error', reject)
    r.end(req.body)
  })

export const defaultDeviceCodeRefresh: DeviceCodeRefresh = (input) =>
  new Promise<unknown>((resolve, reject) => {
    alexaCookie.refreshAlexaCookie(input, (err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })

/** Sleeps `ms`, resolving early when `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

export interface AlexaDeviceCodeSessionOptions {
  readonly sessionId: string
  readonly amazonDomain: string
  readonly logger: IScopedLogger
  readonly http?: DeviceCodeHttp
  readonly refresh?: DeviceCodeRefresh
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly now?: () => number
  readonly onCookie: (sessionId: string, captured: AlexaCapturedCookie) => void
}

/** Amazon's error code from a response body, or '?' — a CODE only, never a body dump. */
function amazonErrorCode(json: unknown): string {
  const parsed = z
    .object({
      response: z.object({
        error: z.object({ code: z.string().optional(), message: z.string().optional() }),
      }),
    })
    .safeParse(json)
  if (parsed.success)
    return parsed.data.response.error.code ?? parsed.data.response.error.message ?? '?'
  const flat = z
    .object({ error: z.string().optional(), message: z.string().optional() })
    .safeParse(json)
  return flat.success ? (flat.data.error ?? flat.data.message ?? '?') : '?'
}

/** One device-code sign-in attempt: start → poll → captured | expired | error | cancelled. */
export class AlexaDeviceCodeSession {
  readonly #o: AlexaDeviceCodeSessionOptions
  readonly #http: DeviceCodeHttp
  readonly #refresh: DeviceCodeRefresh
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly #now: () => number
  readonly #abort = new AbortController()
  readonly #startedAt: number
  readonly #deviceSerial = randomBytes(16).toString('hex')
  readonly #frc = randomBytes(313).toString('base64')
  #phase: AlexaProxyLoginPhase = 'starting'
  #error: string | null = null
  #userCode = ''
  #expiresAt: number | null = null
  #capturedAt: number | null = null
  #poll: Promise<void> = Promise.resolve()

  constructor(opts: AlexaDeviceCodeSessionOptions) {
    this.#o = opts
    this.#http = opts.http ?? defaultDeviceCodeHttp
    this.#refresh = opts.refresh ?? defaultDeviceCodeRefresh
    this.#sleep = opts.sleep ?? abortableSleep
    this.#now = opts.now ?? Date.now
    this.#startedAt = this.#now()
  }

  get #domain(): string {
    return this.#o.amazonDomain
  }

  get #headers(): Readonly<Record<string, string>> {
    return {
      'User-Agent': USER_AGENT,
      'Accept-Language': alexaRegionOptions(this.#domain).acceptLanguage,
      'Accept-Charset': 'utf-8',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-amzn-identity-auth-domain': `api.${this.#domain}`,
    }
  }

  getStatus(): AlexaProxyLoginStatus {
    return {
      sessionId: this.#o.sessionId,
      method: 'device-code',
      phase: this.#phase,
      userCode: this.#phase === 'awaiting-code' ? this.#userCode : '',
      verificationUrl: this.#phase === 'awaiting-code' ? `https://www.${this.#domain}/code` : '',
      expiresAt: this.#expiresAt,
      loginUrl: '',
      amazonDomain: this.#domain,
      error: this.#error,
      startedAt: this.#startedAt,
      capturedAt: this.#capturedAt,
    }
  }

  /** Ask Amazon for a code pair and begin polling. Throws, naming the cause, when refused. */
  async start(): Promise<AlexaProxyLoginStatus> {
    const res = await this.#http({
      host: `api.${this.#domain}`,
      path: '/auth/create/codepair',
      headers: this.#headers,
      body: JSON.stringify({
        code_data: {
          device_serial: this.#deviceSerial,
          device_type: DEVICE_TYPE,
          domain: 'Device',
        },
        code_properties: { code_duration: String(DEFAULT_EXPIRES_S), code_length: '5' },
      }),
    }).catch((err: unknown) => {
      throw this.#fail(`codepair request failed (${errMsg(err)})`)
    })
    const pair = CodepairSchema.safeParse(res.json)
    if (res.status !== 200 || !pair.success) {
      throw this.#fail(
        `Amazon refused the sign-in code: HTTP ${res.status}, error ${amazonErrorCode(res.json)}`,
      )
    }
    const expiresInS = pair.data.expires_in ?? DEFAULT_EXPIRES_S
    this.#userCode = pair.data.public_code
    this.#expiresAt = this.#now() + expiresInS * 1000
    this.#phase = 'awaiting-code'
    this.#o.logger.info('alexa device-code: code issued, waiting for the operator', {
      meta: { sessionId: this.#o.sessionId, amazonDomain: this.#domain, expiresInS },
    })
    const pollMs = (pair.data.polling_interval_in_seconds ?? DEFAULT_POLL_S) * 1000
    this.#poll = this.#pollLoop(pair.data.public_code, pair.data.private_code, pollMs)
    return this.getStatus()
  }

  /** Resolves when polling has ended (tests await it). */
  whenSettled(): Promise<void> {
    return this.#poll
  }

  async cancel(): Promise<void> {
    if (this.#phase === 'awaiting-code' || this.#phase === 'starting') this.#phase = 'cancelled'
    this.#abort.abort()
    await this.#poll
  }

  #fail(reason: string): Error {
    this.#phase = 'error'
    this.#error = reason
    this.#o.logger.warn(`alexa device-code: ${reason}`, {
      meta: { sessionId: this.#o.sessionId, amazonDomain: this.#domain },
    })
    return new Error(`alexa device-code: ${reason}`)
  }

  async #pollLoop(publicCode: string, privateCode: string, pollMs: number): Promise<void> {
    const body = this.#registerBody(publicCode, privateCode)
    const deadline = this.#expiresAt ?? this.#now()
    while (this.#phase === 'awaiting-code') {
      await this.#sleep(pollMs, this.#abort.signal)
      if (this.#phase !== 'awaiting-code') return
      if (this.#now() >= deadline) {
        this.#phase = 'expired'
        this.#error = 'the sign-in code expired before it was confirmed'
        this.#o.logger.info('alexa device-code: code expired', {
          meta: { sessionId: this.#o.sessionId },
        })
        return
      }
      let res: DeviceCodeHttpResponse
      try {
        res = await this.#http({
          host: `api.${this.#domain}`,
          path: '/auth/register',
          headers: this.#headers,
          body,
        })
      } catch (err: unknown) {
        this.#fail(`register request failed (${errMsg(err)})`)
        return
      }
      if (this.#phase !== 'awaiting-code') return
      if (res.status === 401) continue
      const ok = RegisterSuccessSchema.safeParse(res.json)
      if (res.status !== 200 || !ok.success) {
        this.#fail(
          `Amazon refused the registration: HTTP ${res.status}, error ${amazonErrorCode(res.json)}`,
        )
        return
      }
      await this.#finish(ok.data.response.success.tokens)
      return
    }
  }

  async #finish(
    tokens: z.infer<typeof RegisterSuccessSchema>['response']['success']['tokens'],
  ): Promise<void> {
    const domain = this.#domain
    const cookies = tokens.website_cookies.map((c) => `${c.Name}=${c.Value}`)
    const mapMd = Buffer.from(
      JSON.stringify({
        device_user_dictionary: [],
        device_registration_data: { software_version: '1' },
        app_identifier: { app_version: APP_VERSION, bundle_id: 'com.amazon.echo' },
      }),
    ).toString('base64')
    const region = alexaRegionOptions(domain)
    try {
      const refreshed = RefreshedSchema.parse(
        await this.#refresh({
          amazonPage: domain,
          baseAmazonPage: domain,
          acceptLanguage: region.acceptLanguage,
          formerRegistrationData: {
            loginCookie: [`frc=${this.#frc}`, `map-md=${mapMd}`, ...cookies].join('; '),
            refreshToken: tokens.bearer.refresh_token,
            deviceSerial: this.#deviceSerial,
            amazonPage: domain,
          },
        }),
      )
      if (this.#phase !== 'awaiting-code') return
      const cookieData = {
        ...refreshed,
        macDms: tokens.mac_dms,
        deviceSerial: this.#deviceSerial,
        amazonPage: domain,
      }
      this.#phase = 'captured'
      this.#capturedAt = this.#now()
      this.#o.logger.info('alexa device-code: cookie captured', {
        meta: { sessionId: this.#o.sessionId },
      })
      this.#o.onCookie(this.#o.sessionId, { cookieData, cookie: refreshed.localCookie })
    } catch (err: unknown) {
      this.#fail(`the cookie exchange failed (${errMsg(err).slice(0, 200)})`)
    }
  }

  #registerBody(publicCode: string, privateCode: string): string {
    return JSON.stringify({
      requested_extensions: ['device_info', 'customer_info'],
      cookies: { website_cookies: [], domain: `.${this.#domain}` },
      registration_data: {
        domain: 'Device',
        app_version: APP_VERSION,
        device_type: DEVICE_TYPE,
        device_name: "%FIRST_NAME%'s%DUPE_STRATEGY_1ST%CamStack",
        os_version: OS_VERSION,
        device_serial: this.#deviceSerial,
        device_model: 'iPhone',
        app_name: 'CamStack',
        software_version: '1',
      },
      auth_data: {
        code_pair: { public_code: publicCode, private_code: privateCode },
        use_global_authentication: 'true',
      },
      user_context_map: { frc: this.#frc },
      requested_token_type: ['bearer', 'mac_dms', 'website_cookies'],
    })
  }
}
