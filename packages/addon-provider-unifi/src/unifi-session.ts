/**
 * A signed-in session on a UniFi controller with a LOCAL account (username + password), the way
 * the classic controller API is reached. Two flavours, detected from the host:
 *
 *  - a UniFi OS console (UDM, UCG, Cloud Key Gen2+): `GET /` answers 200; sign-in is
 *    `POST /api/auth/login`, the session is the `TOKEN` cookie plus the `X-CSRF-Token` header the
 *    login answered with, and the Network API lives under `/proxy/network/api`;
 *  - a legacy / self-hosted Network controller: `GET /` redirects; sign-in is `POST /api/login`,
 *    the session is the `unifises` (+ `csrf_token`) cookie, the API lives under `/api`.
 *
 * A request answered 401 signs in again ONCE and retries; a second 401 is an auth failure, never
 * a loop. The password is held only in memory and never logged.
 */
import { Agent, fetch as undiciFetch } from 'undici'
import { z } from 'zod'
import { UnifiApiError, UnifiAuthError, UnifiMfaRequiredError } from './unifi-errors.js'

export type UnifiHttpMethod = 'GET' | 'POST' | 'PUT'

export interface UnifiHttpRequest {
  readonly method: UnifiHttpMethod
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

/** The subset of an HTTP response the session reads. Redirects are NOT followed. */
export interface UnifiHttpResponse {
  readonly status: number
  header(name: string): string | null
  setCookies(): readonly string[]
  json(): Promise<unknown>
}

export type UnifiHttp = (url: string, request: UnifiHttpRequest) => Promise<UnifiHttpResponse>

export type UnifiControllerFlavor = 'unifi-os' | 'legacy'

export interface UnifiSessionOptions {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
  readonly http: UnifiHttp
}

const REQUEST_TIMEOUT_MS = 15_000

/** The classic API envelope: `{ meta: { rc, msg }, data }`. */
const envelopeSchema = z.object({
  meta: z.object({ rc: z.string().optional(), msg: z.string().optional() }).optional(),
  data: z.unknown().optional(),
})

const loginErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  meta: z.object({ msg: z.string().optional() }).optional(),
})

/** True when a login refusal is the account asking for a second factor. */
function asksForSecondFactor(status: number, body: z.infer<typeof loginErrorSchema>): boolean {
  if (status === 499) return true
  const words = `${body.code ?? ''} ${body.meta?.msg ?? ''}`.toLowerCase()
  return words.includes('mfa') || words.includes('2fa')
}

export class UnifiSession {
  readonly #origin: string
  readonly #username: string
  readonly #password: string
  readonly #http: UnifiHttp
  #flavor: UnifiControllerFlavor | null = null
  #cookies = new Map<string, string>()
  #csrf: string | null = null
  #signedIn = false

  constructor(options: UnifiSessionOptions) {
    this.#origin = `https://${options.host}:${options.port}`
    this.#username = options.username
    this.#password = options.password
    this.#http = options.http
  }

  /** The detected flavour, or null before the first sign-in. */
  get flavor(): UnifiControllerFlavor | null {
    return this.#flavor
  }

  /** Detect the flavour (once) and sign in. Throws a typed reason on refusal. */
  async login(): Promise<void> {
    const flavor = this.#flavor ?? (await this.#detect())
    this.#flavor = flavor
    this.#cookies = new Map()
    this.#csrf = null
    const path = flavor === 'unifi-os' ? '/api/auth/login' : '/api/login'
    const body =
      flavor === 'unifi-os'
        ? {
            username: this.#username,
            password: this.#password,
            rememberMe: true,
          }
        : {
            username: this.#username,
            password: this.#password,
            remember: true,
          }
    const res = await this.#send('POST', path, body)
    if (res.status >= 200 && res.status < 300) {
      this.#signedIn = true
      return
    }
    const refusal = loginErrorSchema.safeParse(await res.json().catch((): unknown => null))
    const parsed = refusal.success ? refusal.data : {}
    if (asksForSecondFactor(res.status, parsed)) throw new UnifiMfaRequiredError()
    if (res.status === 401 || res.status === 403 || res.status === 400) {
      throw new UnifiAuthError(
        `unifi: the controller refused the username or password (HTTP ${res.status}) — use a LOCAL account of the console, not a UI.com account`,
      )
    }
    if (res.status === 429) {
      throw new UnifiApiError(
        429,
        'unifi: the controller is rate-limiting sign-in; try again later',
      )
    }
    throw new UnifiApiError(res.status, `unifi: sign-in answered HTTP ${res.status}`)
  }

  /** Best-effort sign-out; the session is dropped either way. */
  async logout(): Promise<void> {
    if (!this.#signedIn || this.#flavor === null) return
    const path = this.#flavor === 'unifi-os' ? '/api/auth/logout' : '/api/logout'
    this.#signedIn = false
    await this.#send('POST', path, {}).catch((): null => null)
    this.#cookies = new Map()
    this.#csrf = null
  }

  /**
   * Call the classic Network API (`path` below `/api`, e.g. `/s/default/stat/device`) and answer
   * its `data`. A 401 signs in again once and retries.
   */
  async api(method: UnifiHttpMethod, path: string, body?: unknown): Promise<unknown> {
    if (!this.#signedIn) await this.login()
    let res = await this.#send(method, this.#apiPath(path), body)
    if (res.status === 401) {
      await this.login()
      res = await this.#send(method, this.#apiPath(path), body)
      if (res.status === 401) {
        this.#signedIn = false
        throw new UnifiAuthError('unifi: the controller refused the session after signing in again')
      }
    }
    if (res.status === 403) {
      throw new UnifiAuthError(
        `unifi: the account may not ${method} ${path} (HTTP 403) — it needs admin rights on the site`,
      )
    }
    if (res.status < 200 || res.status >= 300) {
      throw new UnifiApiError(res.status, `unifi: ${method} ${path} -> HTTP ${res.status}`)
    }
    const envelope = envelopeSchema.safeParse(await res.json().catch((): unknown => null))
    if (!envelope.success) return null
    if (envelope.data.meta?.rc === 'error') {
      throw new UnifiApiError(
        res.status,
        `unifi: ${method} ${path} refused: ${envelope.data.meta.msg ?? 'error'}`,
      )
    }
    return envelope.data.data ?? null
  }

  #apiPath(path: string): string {
    return (this.#flavor === 'unifi-os' ? '/proxy/network/api' : '/api') + path
  }

  async #detect(): Promise<UnifiControllerFlavor> {
    const res = await this.#http(`${this.#origin}/`, {
      method: 'GET',
      headers: {},
    })
    // Drain the (HTML) body so the connection is released; its content is not needed.
    await res.json().catch((): null => null)
    return res.status === 200 ? 'unifi-os' : 'legacy'
  }

  async #send(method: UnifiHttpMethod, path: string, body?: unknown): Promise<UnifiHttpResponse> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.#cookies.size > 0) {
      headers['Cookie'] = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    }
    const csrf = this.#csrf ?? this.#cookies.get('csrf_token') ?? null
    if (csrf !== null) headers['X-CSRF-Token'] = csrf
    const res = await this.#http(`${this.#origin}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    this.#absorb(res)
    return res
  }

  /** Keep the cookies and the (rotated) CSRF token a response hands back. */
  #absorb(res: UnifiHttpResponse): void {
    for (const line of res.setCookies()) {
      const pair = line.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
    const csrf = res.header('x-updated-csrf-token') ?? res.header('x-csrf-token')
    if (csrf !== null && csrf !== '') this.#csrf = csrf
  }
}

/** The production HTTP: undici, redirects not followed, a verification-skipping agent only when asked. */
export function makeUndiciHttp(allowSelfSigned: boolean): UnifiHttp {
  const dispatcher = allowSelfSigned
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined
  return async (url, request) => {
    const res = await undiciFetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      dispatcher,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return {
      status: res.status,
      header: (name) => res.headers.get(name),
      setCookies: () => res.headers.getSetCookie(),
      json: () => res.json(),
    }
  }
}
