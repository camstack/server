import { userError } from '@camstack/types'
/**
 * Pending "Sign in the CamStack app as <user>?" confirmations (D858).
 *
 * A custom URL scheme can be claimed by any app on the phone, so a browser leg
 * that ends in `camstack://…?code=…` could hand a code to an app the user never
 * meant to sign in (one that started the flow itself, with its own PKCE
 * challenge, while an IdP session was live). The code is therefore minted only
 * AFTER the signed-in person confirms, on a page the hub renders:
 *
 *  - the finished ceremony parks an entry here, keyed by a one-shot token;
 *  - the token travels in the URL, but is useless without the browser-bound
 *    cookie the entry was created with (the cookie's hash is kept, not the cookie);
 *  - it lives {@link APP_CONFIRM_TTL_MS}, is consumed by the first `consume`
 *    whatever the outcome, and the store is bounded.
 *
 * In-memory only: a hub restart simply means the person signs in again.
 */
import * as crypto from 'node:crypto'
import type { AppFlowRequest } from '@camstack/types'

export const APP_CONFIRM_TTL_MS = 120_000
const MAX_PENDING = 500

/** The cookie that binds a confirmation to the browser that finished the ceremony. */
export const APP_CONFIRM_COOKIE = 'camstack_app_confirm'

export interface AppConfirmation {
  readonly userId: string
  readonly username: string
  readonly app: AppFlowRequest
  /** How the person authenticated just now. */
  readonly authMethod: 'sso' | 'passkey'
}

interface Entry extends AppConfirmation {
  readonly cookieHash: string
  readonly expiresAt: number
}

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex')

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export class AppConfirmations {
  /** Keyed by SHA-256(token). */
  private readonly pending = new Map<string, Entry>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Park a confirmation. Returns the one-shot token and the cookie value to set. */
  create(confirmation: AppConfirmation): { readonly token: string; readonly cookie: string } {
    this.prune()
    if (this.pending.size >= MAX_PENDING)
      throw userError(
        'server.app-confirmations-busy',
        undefined,
        'Too many pending app confirmations',
      )
    const token = crypto.randomBytes(32).toString('base64url')
    const cookie = crypto.randomBytes(32).toString('base64url')
    this.pending.set(sha256(token), {
      ...confirmation,
      cookieHash: sha256(cookie),
      expiresAt: this.now() + APP_CONFIRM_TTL_MS,
    })
    return { token, cookie }
  }

  /** Read without consuming (to render the page). `null` unless token and cookie both match. */
  peek(token: string, cookie: string | null): AppConfirmation | null {
    this.prune()
    const entry = this.pending.get(sha256(token))
    if (entry === undefined || cookie === null || !sameDigest(sha256(cookie), entry.cookieHash)) {
      return null
    }
    return this.view(entry)
  }

  /**
   * Spend the token. Burned on the FIRST attempt whatever the outcome - a wrong
   * cookie included, so a leaked token cannot be probed with guesses.
   */
  consume(token: string, cookie: string | null): AppConfirmation | null {
    this.prune()
    const key = sha256(token)
    const entry = this.pending.get(key)
    if (entry === undefined) return null
    this.pending.delete(key)
    if (cookie === null || !sameDigest(sha256(cookie), entry.cookieHash)) return null
    return this.view(entry)
  }

  get pendingCount(): number {
    return this.pending.size
  }

  private view(entry: Entry): AppConfirmation {
    return {
      userId: entry.userId,
      username: entry.username,
      app: entry.app,
      authMethod: entry.authMethod,
    }
  }

  private prune(): void {
    const at = this.now()
    for (const [key, entry] of this.pending) if (at > entry.expiresAt) this.pending.delete(key)
  }
}
