/**
 * The Dahua **RPC2** surface — the second protocol this addon speaks, and it
 * exists for exactly one reason: `mediaFileFind` has no working CGI form on
 * this firmware.
 *
 * Everything else this addon does is plain digest CGI and stays there. The
 * split was MEASURED, not assumed (2026-09-23, device 3836,
 * `2.800.1ENN001.0.R`):
 *
 * | probe | answer |
 * | --- | --- |
 * | `storageDevice.cgi?action=getDeviceAllInfo` | **200**, the same rows RPC2 gives — so storage needs no RPC2 |
 * | `mediaFileFind.cgi?action=factory.create` | **200**, `result=<handle>` |
 * | `mediaFileFind.cgi?action=findFile&…` | **400 `Bad Request!`** on five different condition encodings |
 * | `mediaFileFind.cgi?action=findNextFile` after that 400 | **200 `found=0`** |
 *
 * That last line is the whole reason this file exists rather than a few more
 * CGI helpers: over CGI the search cannot be STARTED, and the enumeration that
 * follows the failed start answers cleanly with nothing. A reader that checked
 * only the enumeration would report an authoritative "this camera has no
 * clips" from a search that never ran.
 *
 * ## Session discipline
 *
 * Login is the two-step challenge on `/RPC2_Login`: an unauthenticated
 * `global.login` answers with `realm` and `random` — and answers them on a
 * `result: false` envelope, which is why {@link AmcrestRpc2Result} carries
 * `params` on BOTH branches. The second leg sends
 * `MD5(user:random:MD5(user:realm:pass))`. Every later call goes to `/RPC2`
 * carrying the session.
 *
 * A session is held for {@link RPC2_SESSION_TTL_MS} and then thrown away. It is
 * deliberately NOT kept alive by a timer: a listing is an operator-driven read
 * a few times an hour, a keep-alive timer is something a run arms that
 * outlives it (D604), and a login measured well under a second is not worth a
 * background clock. A call that comes back with a session error re-logs in
 * ONCE and retries — a second failure is the camera's answer, not ours.
 *
 * Credentials live in this object and never reach a log line.
 */
import { createHash } from 'node:crypto'

/** Default per-request timeout. A `findFile` over a 30-day window measured
 *  629 ms; 15 s bounds a hung socket, it is not a budget. */
export const RPC2_DEFAULT_TIMEOUT_MS = 15_000

/**
 * How long one login is reused.
 *
 * Dahua answers a `keepAliveInterval` (60 s on this firmware) and expects a
 * `global.keepAlive` inside it. Rather than run that clock, a session is used
 * for half that interval and re-minted after — so a catalog read costs at most
 * one extra round-trip and nothing is armed between reads.
 */
export const RPC2_SESSION_TTL_MS = 30_000

export interface AmcrestRpc2ClientOptions {
  readonly host: string
  readonly port: number
  readonly https: boolean
  readonly username: string
  readonly password: string
  readonly defaultTimeoutMs?: number
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch
  /** Injected in tests. Defaults to `Date.now`. */
  readonly now?: () => number
}

/** The camera's own refusal, verbatim. The `message` is routinely EMPTY on
 *  this firmware — `findFile` fails with code 285409284 and no words at all —
 *  which is why {@link code} travels beside it. */
export interface AmcrestRpc2Error {
  readonly code: number | null
  readonly message: string
}

/**
 * One RPC2 answer.
 *
 * `ok` is the camera's own `result === true` and NOTHING else. Every reader in
 * this addon gates on it: `findNextFile` answers `result:true, found:0` after
 * a `findFile` that failed, so an enumeration's own success is never evidence
 * that the search behind it ran.
 *
 * `params` is carried on the refused branch too, because the login challenge
 * IS a refusal that carries the payload the next leg needs.
 */
export type AmcrestRpc2Result =
  | {
      readonly kind: 'ok'
      readonly params: Readonly<Record<string, unknown>>
      readonly session: string | null
      /**
       * The envelope's own `result`, VERBATIM — because Dahua overloads it.
       * `mediaFileFind.findFile` answers `true`; `mediaFileFind.factory.create`
       * answers the find-object HANDLE as a number on the same field. So
       * "succeeded" is `result !== false`, and a caller that needs the handle
       * reads it from here rather than from `params`, which is empty on that
       * call.
       */
      readonly result: unknown
    }
  | {
      readonly kind: 'refused'
      readonly error: AmcrestRpc2Error
      readonly params: Readonly<Record<string, unknown>>
      readonly session: string | null
    }
  /**
   * The call did not complete — transport, timeout, or a body that was not
   * JSON. Never folded into `refused`: a camera that did not answer has not
   * said no (D393).
   */
  | { readonly kind: 'unreachable'; readonly detail: string }

/** Why a login did not produce a session. Named so a caller can say which. */
export type AmcrestRpc2LoginOutcome =
  | { readonly kind: 'ok'; readonly session: string }
  | { readonly kind: 'refused'; readonly error: AmcrestRpc2Error }
  | { readonly kind: 'unreachable'; readonly detail: string }

interface Rpc2Session {
  readonly id: string
  readonly mintedAtMs: number
}

const EMPTY_PARAMS: Readonly<Record<string, unknown>> = Object.freeze({})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Error codes that mean "your session is gone", so one silent re-login is the
 * right answer rather than a refusal the operator reads.
 *
 * Deliberately a SHORT list. An unknown code is a refusal — guessing that any
 * failure is a stale session turns one camera refusal into two round-trips and
 * the same refusal, and `findFile`'s 285409284 (which means "nothing matched,
 * or your condition was malformed") would then be retried on every empty day.
 */
export const RPC2_SESSION_LOST_CODES: ReadonlySet<number> = new Set([
  268632064, // invalid / timed-out session
  268632081, // not logged in
])

function md5Upper(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex').toUpperCase()
}

/**
 * A minimal Dahua RPC2 client. One per camera.
 *
 * It exposes exactly what the clip catalog needs — `call`, plus the login
 * `call` performs for itself. There is no generic "raw request" escape hatch:
 * a second way into this protocol is a second place to get the session
 * discipline wrong.
 */
export class AmcrestRpc2Client {
  private readonly base: string
  private readonly username: string
  private readonly password: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private session: Rpc2Session | null = null
  private nextId = 0
  private loginInFlight: Promise<AmcrestRpc2LoginOutcome> | null = null

  constructor(opts: AmcrestRpc2ClientOptions) {
    this.base = `${opts.https ? 'https' : 'http'}://${opts.host}:${String(opts.port)}`
    this.username = opts.username
    this.password = opts.password
    this.timeoutMs = opts.defaultTimeoutMs ?? RPC2_DEFAULT_TIMEOUT_MS
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? ((): number => Date.now())
  }

  /**
   * One RPC2 call, logging in first when there is no live session.
   *
   * `object` is the find-object handle for the `mediaFileFind.*` methods that
   * take one; absent for the factory and for `global.*`.
   */
  async call(
    method: string,
    params: Readonly<Record<string, unknown>> | null,
    object?: number,
  ): Promise<AmcrestRpc2Result> {
    const session = await this.ensureSession()
    if (session.kind === 'unreachable') return { kind: 'unreachable', detail: session.detail }
    if (session.kind === 'refused') {
      return { kind: 'refused', error: session.error, params: EMPTY_PARAMS, session: null }
    }
    const first = await this.post('/RPC2', method, params, object, session.session)
    if (
      first.kind === 'refused' &&
      first.error.code !== null &&
      RPC2_SESSION_LOST_CODES.has(first.error.code)
    ) {
      // The session died under us. ONE re-login, then the camera's answer
      // stands whatever it is — a retry loop here would turn a real refusal
      // into an unbounded one.
      this.session = null
      const fresh = await this.ensureSession()
      if (fresh.kind !== 'ok') return first
      return await this.post('/RPC2', method, params, object, fresh.session)
    }
    return first
  }

  /** Drop the session and tell the camera, best-effort. For a client whose
   *  device is going away. */
  async logout(): Promise<void> {
    const session = this.session
    this.session = null
    if (session === null) return
    await this.post('/RPC2', 'global.logout', null, undefined, session.id)
  }

  /** Forget the cached session WITHOUT telling the camera — for a client whose
   *  host or credentials just changed under it, where the old session id means
   *  nothing at the new address. */
  reset(): void {
    this.session = null
  }

  private async ensureSession(): Promise<AmcrestRpc2LoginOutcome> {
    const live = this.session
    if (live !== null && this.now() - live.mintedAtMs < RPC2_SESSION_TTL_MS) {
      return { kind: 'ok', session: live.id }
    }
    this.session = null
    // A second caller never opens a second login: two logins race to the same
    // session id and the loser's is already dead when it is used.
    const inFlight = this.loginInFlight
    if (inFlight !== null) return await inFlight
    const promise = this.login()
    this.loginInFlight = promise
    try {
      return await promise
    } finally {
      this.loginInFlight = null
    }
  }

  private async login(): Promise<AmcrestRpc2LoginOutcome> {
    const challenge = await this.post(
      '/RPC2_Login',
      'global.login',
      { userName: this.username, password: '', clientType: 'Web3.0' },
      undefined,
      null,
    )
    if (challenge.kind === 'unreachable') {
      return { kind: 'unreachable', detail: challenge.detail }
    }
    // The challenge leg answers `result: false` BY DESIGN — its payload is the
    // realm and the random, not a verdict. Only the absence of those is a
    // failure here, so the branch is taken on the FIELDS and never on `result`.
    const sessionId = challenge.session
    const realm = challenge.params['realm']
    const random = challenge.params['random']
    if (
      sessionId === null ||
      typeof realm !== 'string' ||
      typeof random !== 'string' ||
      realm === '' ||
      random === ''
    ) {
      return {
        kind: 'refused',
        error:
          challenge.kind === 'refused'
            ? challenge.error
            : { code: null, message: 'the login challenge carried no realm/random' },
      }
    }
    const inner = md5Upper(`${this.username}:${realm}:${this.password}`)
    const hashed = md5Upper(`${this.username}:${random}:${inner}`)
    const confirmed = await this.post(
      '/RPC2_Login',
      'global.login',
      {
        userName: this.username,
        password: hashed,
        clientType: 'Web3.0',
        loginType: 'Direct',
        authorityType: 'Default',
        passwordType: 'Default',
      },
      undefined,
      sessionId,
    )
    if (confirmed.kind === 'unreachable') return { kind: 'unreachable', detail: confirmed.detail }
    if (confirmed.kind === 'refused') return { kind: 'refused', error: confirmed.error }
    this.session = { id: sessionId, mintedAtMs: this.now() }
    return { kind: 'ok', session: sessionId }
  }

  private async post(
    path: string,
    method: string,
    params: Readonly<Record<string, unknown>> | null,
    object: number | undefined,
    session: string | null,
  ): Promise<AmcrestRpc2Result> {
    this.nextId += 1
    const body: Record<string, unknown> = { method, params, id: this.nextId }
    if (object !== undefined) body['object'] = object
    if (session !== null) body['session'] = session
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return {
          kind: 'unreachable',
          detail: `RPC2 ${method} answered HTTP ${String(res.status)} with a body that is not JSON`,
        }
      }
      if (!isRecord(parsed)) {
        return { kind: 'unreachable', detail: `RPC2 ${method} answered a non-object body` }
      }
      const answeredParams = isRecord(parsed['params']) ? parsed['params'] : EMPTY_PARAMS
      const answeredSession = readSessionId(parsed['session'])
      const answeredResult = parsed['result']
      // NOT `=== true`. `factory.create` answers the find-object handle as a
      // NUMBER on this field, and treating that as a refusal would make every
      // search fail before it started. A refusal is `false`, or nothing at all.
      if (answeredResult !== false && answeredResult !== undefined && answeredResult !== null) {
        return {
          kind: 'ok',
          params: answeredParams,
          session: answeredSession,
          result: answeredResult,
        }
      }
      return {
        kind: 'refused',
        error: readError(parsed['error']),
        params: answeredParams,
        session: answeredSession,
      }
    } catch (err: unknown) {
      return { kind: 'unreachable', detail: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }
}

function readSessionId(raw: unknown): string | null {
  if (typeof raw === 'string' && raw !== '') return raw
  if (typeof raw === 'number') return String(raw)
  return null
}

function readError(raw: unknown): AmcrestRpc2Error {
  if (!isRecord(raw)) return { code: null, message: '' }
  const code = typeof raw['code'] === 'number' ? raw['code'] : null
  const message = typeof raw['message'] === 'string' ? raw['message'] : ''
  return { code, message }
}
