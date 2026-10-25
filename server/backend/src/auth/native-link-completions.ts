/**
 * Native-app account links waiting for the app to claim them (D801).
 *
 * A link started from the native viewer finishes in the SYSTEM browser, which
 * holds no hub session — so the SSO finish cannot check "the browser is signed
 * in as the intent's user" (D782's binding). Instead it parks what it verified
 * — the intent's user and the IdP identity — under a one-time code, and sends
 * the browser back to the app's custom scheme with that code. The app claims it
 * over `auth.completeExternalLink` with its own bearer, and the router binds it
 * there: the caller must BE the intent's user.
 *
 * Same shape as the handoff codes: the raw code exists once (only its hash is
 * kept), lives 60 s, is consumed by its first claim attempt whatever the
 * outcome, and the store is bounded. In memory: a hub restart mid-link costs
 * one more tap.
 */
import { createHash, randomBytes } from 'node:crypto'

export const NATIVE_LINK_CODE_PREFIX = 'nlc_'
export const NATIVE_LINK_CODE_TTL_MS = 60_000
const MAX_PENDING = 1_000

export interface ParkedNativeLink {
  /** The user the link intent was minted for. */
  readonly userId: string
  readonly provider: string
  readonly subject: string
  readonly issuer: string
  readonly label?: string
}

interface Entry extends ParkedNativeLink {
  readonly expiresAt: number
}

function hash(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export class NativeLinkCompletions {
  private readonly pending = new Map<string, Entry>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? NATIVE_LINK_CODE_TTL_MS
  }

  /** Park a verified link; returns the raw one-time code. */
  park(link: ParkedNativeLink): string {
    this.prune()
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next()
      if (oldest.done) break
      this.pending.delete(oldest.value)
    }
    const code = `${NATIVE_LINK_CODE_PREFIX}${randomBytes(32).toString('base64url')}`
    this.pending.set(hash(code), { ...link, expiresAt: this.now() + this.ttlMs })
    return code
  }

  /** The parked link, consumed — or `null` (unknown, used, expired). */
  claim(code: string): ParkedNativeLink | null {
    const key = hash(code)
    const entry = this.pending.get(key)
    if (entry === undefined) return null
    this.pending.delete(key)
    if (entry.expiresAt <= this.now()) return null
    const { expiresAt: _expiresAt, ...link } = entry
    return link
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(key)
    }
  }
}
