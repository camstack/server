import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  AlexaCapturedCookie,
  AlexaProxyLoginPhase,
  AlexaProxyLoginStatus,
} from './alexa-login-status.js'
import { alexaRegionOptions } from './alexa-region-options.js'
import { DEVICE_TYPE, USER_AGENT } from './amazon-auth/constants.js'
import { defaultAmazonHttp, type AmazonHttp } from './amazon-auth/http.js'
import {
  buildMapMd,
  completeRegistration,
  registerDevice,
  type RegisterTokens,
} from './amazon-auth/register-device.js'

/**
 * Amazon's DEVICE-CODE sign-in for the Alexa broker. It avoids every Amazon sign-in page
 * (so it does not depend on the OAuth redirect the proxied login needs):
 *
 *   1. `POST api.<domain>/auth/create/codepair` → a short public code + a private one;
 *   2. the operator opens `https://www.<domain>/code` on ANY device, signs in and types the code;
 *   3. we poll `/auth/register` with the code pair — HTTP 401 until the operator confirmed;
 *   4. the registration returns a refresh token + website cookies; the shared registration
 *      refresh (`amazon-auth/registration.ts`) turns them into the cookie + csrf;
 *   5. the result is the SAME registration blob the proxy login captures (refresh token,
 *      macDms, deviceSerial, localCookie, csrf, amazonPage …), so commit and the broker's
 *      auto-refresh are unchanged.
 *
 * The private code, tokens and cookies never reach a status, a log line or an error.
 */

const DEFAULT_EXPIRES_S = 600
const DEFAULT_POLL_S = 5
/** Consecutive network errors or 5xx answers a poll rides out before the sign-in ends. */
const MAX_TRANSIENT_FAILURES = 4

const CodepairSchema = z.object({
  public_code: z.string().min(1),
  private_code: z.string().min(1),
  expires_in: z.coerce.number().positive().optional(),
  polling_interval_in_seconds: z.coerce.number().positive().optional(),
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
  readonly http?: AmazonHttp
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
  readonly #http: AmazonHttp
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
    this.#http = opts.http ?? defaultAmazonHttp
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
      method: 'POST',
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
    const deadline = this.#expiresAt ?? this.#now()
    let transient = 0
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
      let outcome: Awaited<ReturnType<typeof registerDevice>>
      try {
        outcome = await registerDevice(
          {
            amazonPage: this.#domain,
            deviceSerial: this.#deviceSerial,
            frc: this.#frc,
            auth: { kind: 'code-pair', publicCode, privateCode },
          },
          this.#http,
        )
      } catch (err: unknown) {
        transient += 1
        if (transient < MAX_TRANSIENT_FAILURES) continue
        this.#fail(`register request failed (${errMsg(err)})`)
        return
      }
      if (this.#phase !== 'awaiting-code') return
      if (outcome.kind === 'refused') {
        if (outcome.status >= 500) {
          transient += 1
          if (transient < MAX_TRANSIENT_FAILURES) continue
        } else {
          transient = 0
        }
        // HTTP 401 until the operator confirmed the code.
        if (outcome.status === 401) continue
        this.#fail(`Amazon refused the registration: HTTP ${outcome.status}, error ${outcome.code}`)
        return
      }
      await this.#finish(outcome.tokens)
      return
    }
  }

  async #finish(tokens: RegisterTokens): Promise<void> {
    const domain = this.#domain
    try {
      const registration = await completeRegistration(
        tokens,
        {
          amazonPage: domain,
          deviceSerial: this.#deviceSerial,
          frc: this.#frc,
          mapMd: buildMapMd(),
        },
        this.#http,
        { now: this.#now, acceptLanguage: alexaRegionOptions(domain).acceptLanguage },
      )
      if (this.#phase !== 'awaiting-code') return
      this.#phase = 'captured'
      this.#capturedAt = this.#now()
      this.#o.logger.info('alexa device-code: cookie captured', {
        meta: { sessionId: this.#o.sessionId },
      })
      this.#o.onCookie(this.#o.sessionId, {
        cookieData: registration,
        cookie: registration.localCookie,
      })
    } catch (err: unknown) {
      this.#fail(`the cookie exchange failed (${errMsg(err).slice(0, 200)})`)
    }
  }
}
