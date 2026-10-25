/**
 * Pending "link this sign-in account" requests (D782).
 *
 * A signed-in user presses "Link Authentik": `auth.beginExternalLink` mints
 * an intent for THAT session's user and returns the provider's start URL with
 * the intent's opaque handle as `?link=`. The handle rides the IdP round trip
 * (the OIDC addon keeps it in its server-side pending state, keyed by the
 * OAuth `state`) and comes back inside the signed bridge. The SSO finish
 * resolves it here — once — to the user it was minted for. The user id never
 * travels through the browser.
 *
 * Hub-local and in memory on purpose: an intent lives minutes, and a hub
 * restart mid-link costs the user one more click.
 */
import { randomBytes } from 'node:crypto'

export interface ExternalLinkIntent {
  readonly userId: string
  readonly provider: string
  /**
   * The native app's custom-scheme callback (D801) — set only for a link
   * started from the app, already checked against `APP_AUTH_CALLBACK_URLS`.
   * The finish then hands the outcome back there instead of to the profile.
   */
  readonly returnTo?: string
}

interface StoredIntent extends ExternalLinkIntent {
  readonly expiresAt: number
}

/** Long enough for an IdP login with a password manager; short enough to be useless later. */
const DEFAULT_TTL_MS = 10 * 60_000
/** Bounded: a session minting intents in a loop cannot grow this without limit. */
const DEFAULT_MAX_ENTRIES = 1_000

export class ExternalLinkIntents {
  private readonly intents = new Map<string, StoredIntent>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxEntries: number

  constructor(opts: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  create(userId: string, provider: string, returnTo?: string): string {
    this.prune()
    while (this.intents.size >= this.maxEntries) {
      const oldest = this.intents.keys().next()
      if (oldest.done) break
      this.intents.delete(oldest.value)
    }
    const handle = `li_${randomBytes(24).toString('base64url')}`
    this.intents.set(handle, {
      userId,
      provider,
      ...(returnTo !== undefined ? { returnTo } : {}),
      expiresAt: this.now() + this.ttlMs,
    })
    return handle
  }

  /** The intent behind `handle`, removing it — or `null` (unknown, used, expired). */
  consume(handle: string): ExternalLinkIntent | null {
    const stored = this.intents.get(handle)
    if (stored === undefined) return null
    this.intents.delete(handle)
    if (stored.expiresAt < this.now()) return null
    return {
      userId: stored.userId,
      provider: stored.provider,
      ...(stored.returnTo !== undefined ? { returnTo: stored.returnTo } : {}),
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [handle, intent] of this.intents) {
      if (intent.expiresAt < now) this.intents.delete(handle)
    }
  }
}
