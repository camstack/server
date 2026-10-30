import { randomBytes } from 'node:crypto'
import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  AlexaDeviceCodeSession,
  type AlexaDeviceCodeSessionOptions,
} from './alexa-device-code-login.js'
import type { AlexaCapturedCookie, AlexaProxyLoginStatus } from './alexa-proxy-login.js'

/** What the wizard needs to show the operator after `POST /login/code/start`. */
export interface AlexaDeviceCodeStartResult {
  readonly sessionId: string
  readonly userCode: string
  readonly verificationUrl: string
  readonly expiresAt: number
}

export interface AlexaDeviceCodeManagerDeps {
  readonly logger: IScopedLogger
  /** Test seams (HTTPS, cookie refresh, sleep, clock) forwarded to each session. */
  readonly session?: Pick<AlexaDeviceCodeSessionOptions, 'http' | 'refresh' | 'sleep' | 'now'>
}

/**
 * Owns the live device-code sign-in session of the addon (one at a time, like the proxy
 * login) and keeps the captured material until the wizard commits it onto a broker. The
 * captured cookie never leaves through `status`.
 */
export class AlexaDeviceCodeManager {
  readonly #deps: AlexaDeviceCodeManagerDeps
  #session: AlexaDeviceCodeSession | null = null
  readonly #captured = new Map<string, AlexaCapturedCookie>()

  constructor(deps: AlexaDeviceCodeManagerDeps) {
    this.#deps = deps
  }

  async start(amazonDomain: string): Promise<AlexaDeviceCodeStartResult> {
    await this.cancelActive()
    const sessionId = randomBytes(9).toString('base64url')
    const session = new AlexaDeviceCodeSession({
      ...this.#deps.session,
      sessionId,
      amazonDomain,
      logger: this.#deps.logger,
      onCookie: (id, captured) => {
        this.#captured.set(id, captured)
      },
    })
    const status = await session.start()
    this.#session = session
    return {
      sessionId,
      userCode: status.userCode,
      verificationUrl: status.verificationUrl,
      expiresAt: status.expiresAt ?? 0,
    }
  }

  status(sessionId: string): AlexaProxyLoginStatus | null {
    const status = this.#session?.getStatus() ?? null
    return status !== null && status.sessionId === sessionId ? status : null
  }

  takeCaptured(sessionId: string): AlexaCapturedCookie | null {
    const captured = this.#captured.get(sessionId) ?? null
    if (captured !== null) this.#captured.delete(sessionId)
    return captured
  }

  async cancel(sessionId: string): Promise<void> {
    if (this.#session?.getStatus().sessionId !== sessionId) return
    await this.cancelActive()
    this.#captured.delete(sessionId)
  }

  async cancelActive(): Promise<void> {
    const session = this.#session
    this.#session = null
    if (session === null) return
    try {
      await session.cancel()
    } catch (err: unknown) {
      this.#deps.logger.warn('alexa device-code: cancelActive failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  async dispose(): Promise<void> {
    await this.cancelActive()
    this.#captured.clear()
  }
}
