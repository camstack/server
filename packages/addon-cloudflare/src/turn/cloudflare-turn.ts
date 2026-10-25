import type { IScopedLogger } from '@camstack/types'

export interface CloudflareTurnConfig {
  /**
   * Cloudflare Realtime TURN app's "Token ID" (also called "Key ID" in the
   * dashboard). Pasted into the `accountId` field for historical reasons —
   * Cloudflare's docs use both naming conventions.
   */
  readonly accountId: string
  /** Cloudflare Realtime TURN app's API Token (bearer credential). */
  readonly apiToken: string
}

type TurnServer = { urls: string | string[]; username?: string; credential?: string }

export type TestCredentialsResult =
  | {
      ok: true
      urlCount: number
      hasCredentials: boolean
      firstUrl?: string
    }
  | {
      ok: false
      status?: number
      body: string
      hint?: string
    }

/**
 * Cloudflare returns ICE servers in several flavours depending on which
 * endpoint variant + dashboard age:
 *
 *   A) `{ iceServers: { urls: [...], username, credential } }`        — single ICE server object
 *   B) `{ iceServers: [ { urls, username, credential }, ... ] }`      — array of objects
 *   C) `{ urls: [...], username, credential }`                        — flat (no iceServers wrap)
 *   D) `{ urls: 'stun:...', ... }` (single string instead of array)
 *
 * `parseCloudflareTurnResponse` normalises all of them into our
 * canonical `TurnServer[]`. Returns `[]` when the payload doesn't carry
 * any usable URL (caller logs + falls back to stale cache).
 */
function parseCloudflareTurnResponse(body: unknown): readonly TurnServer[] {
  if (!body || typeof body !== 'object') return []
  const b = body as Record<string, unknown>
  // C+D: flat — body itself is an ICE server.
  if ('urls' in b) {
    const s = coerceTurnServer(b)
    return s ? [s] : []
  }
  const ice = b['iceServers']
  if (!ice) return []
  // B: array of servers.
  if (Array.isArray(ice)) {
    return ice
      .map((entry) =>
        entry && typeof entry === 'object'
          ? coerceTurnServer(entry as Record<string, unknown>)
          : null,
      )
      .filter((s): s is TurnServer => s !== null)
  }
  // A: nested single object.
  if (typeof ice === 'object') {
    const s = coerceTurnServer(ice as Record<string, unknown>)
    return s ? [s] : []
  }
  return []
}

function coerceTurnServer(obj: Record<string, unknown>): TurnServer | null {
  const urls = obj['urls']
  if (!urls) return null
  let normalisedUrls: string | string[]
  if (Array.isArray(urls)) {
    const strs = urls.filter((u): u is string => typeof u === 'string')
    if (strs.length === 0) return null
    normalisedUrls = strs
  } else if (typeof urls === 'string') {
    normalisedUrls = urls
  } else {
    return null
  }
  const username = obj['username']
  const credential = obj['credential']
  return {
    urls: normalisedUrls,
    ...(typeof username === 'string' ? { username } : {}),
    ...(typeof credential === 'string' ? { credential } : {}),
  }
}

const TURN_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys'

/**
 * Credential lifetime (seconds) requested from Cloudflare. The hub
 * refreshes well before expiry; consumers (WebRTC sessions) get them
 * fresh per ICE-server enumeration.
 */
const TTL_SECONDS = 86_400
/** Refresh slightly before TTL/2 so a slow request never returns expired creds. */
const REFRESH_BEFORE_MS = (TTL_SECONDS * 1000) / 2

interface CachedServers {
  readonly servers: readonly TurnServer[]
  readonly fetchedAt: number
}

/**
 * Cloudflare TURN/STUN provider.
 *
 * Implements the `turn-provider` capability. On each call, returns the
 * cached short-lived ICE servers (refreshed in the background ~12h
 * before expiry). The first call kicks off the initial fetch — until
 * it completes, an empty list is returned so the WebRTC layer falls
 * back to other providers / no TURN.
 */
export class CloudflareTurnService {
  readonly id = 'cloudflare-turn'
  readonly name = 'Cloudflare TURN'

  private cached: CachedServers | null = null
  /** In-flight refresh promise — coalesces concurrent fetches. */
  private inflight: Promise<readonly TurnServer[]> | null = null

  constructor(
    private readonly config: CloudflareTurnConfig,
    private readonly logger: IScopedLogger,
  ) {}

  /**
   * One-shot probe used by the settings UI's "Test credentials" button.
   * Bypasses the cache so the operator sees what the LIVE Cloudflare
   * response is for the currently-typed credentials. Returns a
   * structured success/failure envelope so the form can render a clear
   * outcome (✓ with server count, ✗ with status + body).
   */
  async testCredentials(): Promise<TestCredentialsResult> {
    if (!this.config.accountId || !this.config.apiToken) {
      return {
        ok: false,
        body: 'TURN Key ID and API Token must both be filled before testing.',
      }
    }
    const url = `${TURN_API_BASE}/${encodeURIComponent(this.config.accountId)}/credentials/generate-ice-servers`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      })
    } catch (err) {
      return {
        ok: false,
        body: `Network error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const looksLikeKeyMismatch = res.status === 404 && text.includes('cannot find specified key')
      const hint = looksLikeKeyMismatch
        ? 'The "TURN Key ID" does not match any of your TURN apps. Open dash.cloudflare.com → Realtime → TURN and copy the Token ID shown on that page (not the Cloudflare Account ID).'
        : res.status === 401 || res.status === 403
          ? "Authentication failed — the API Token is invalid or doesn't belong to this TURN app. Regenerate the API Token from the TURN app's page."
          : undefined
      return {
        ok: false,
        status: res.status,
        body: text.slice(0, 500),
        ...(hint ? { hint } : {}),
      }
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return { ok: false, body: 'Response was not JSON' }
    }
    const servers = parseCloudflareTurnResponse(body)
    if (servers.length === 0) {
      return {
        ok: false,
        body: `Could not parse ICE servers from response. Raw: ${JSON.stringify(body).slice(0, 400)}`,
      }
    }
    const totalUrls = servers.reduce((n, s) => n + (Array.isArray(s.urls) ? s.urls.length : 1), 0)
    const hasCredentials = servers.some((s) => s.username && s.credential)
    const firstServer = servers[0]
    const firstUrl = firstServer
      ? Array.isArray(firstServer.urls)
        ? firstServer.urls[0]
        : firstServer.urls
      : undefined
    return {
      ok: true,
      urlCount: totalUrls,
      hasCredentials,
      ...(firstUrl ? { firstUrl: String(firstUrl) } : {}),
    }
  }

  async getTurnServers(): Promise<readonly TurnServer[]> {
    if (!this.config.accountId || !this.config.apiToken) {
      // Not configuring Cloudflare TURN is a valid state (LAN-only / other TURN
      // provider), so a per-session "not configured" is expected, not a fault.
      this.logger.debug('Cloudflare TURN: credentials not configured — skipping fetch')
      return []
    }
    // Cache hit: return immediately + refresh in the background when
    // we're past the halfway mark.
    if (this.cached) {
      const age = Date.now() - this.cached.fetchedAt
      if (age < REFRESH_BEFORE_MS) return this.cached.servers
      // Stale — kick off refresh but serve the (still-valid) cache to
      // the caller. The next caller after refresh completes gets fresh.
      void this.refresh()
      return this.cached.servers
    }
    // Cold: await the first fetch so the consumer doesn't see []
    // when credentials ARE configured.
    return this.refresh()
  }

  private async refresh(): Promise<readonly TurnServer[]> {
    if (this.inflight) return this.inflight
    this.inflight = this.doFetch().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doFetch(): Promise<readonly TurnServer[]> {
    const url = `${TURN_API_BASE}/${encodeURIComponent(this.config.accountId)}/credentials/generate-ice-servers`
    this.logger.debug('Fetching TURN servers from Cloudflare', { meta: { url } })
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error('Cloudflare TURN fetch failed (network error)', { meta: { error: msg } })
      return this.cached?.servers ?? []
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // 404 "cannot find specified key" is the operator-actionable hint:
      // the TURN Key ID field was filled with the wrong value (most often
      // the Cloudflare Account ID instead of the per-app Token ID).
      const looksLikeKeyMismatch = res.status === 404 && text.includes('cannot find specified key')
      // Mask all but the first/last 4 chars of the key so it's safe to
      // log + paste into a bug report.
      const k = this.config.accountId
      const keyMasked = k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '***'
      this.logger.error('Cloudflare TURN fetch failed', {
        meta: {
          status: res.status,
          statusText: res.statusText,
          body: text.slice(0, 500),
          url: `${TURN_API_BASE}/${keyMasked}/credentials/generate-ice-servers`,
          keyMasked,
          tokenLength: this.config.apiToken.length,
          hint: looksLikeKeyMismatch
            ? 'The "TURN Key ID" field does NOT accept the Cloudflare Account ID. Open dash.cloudflare.com → Realtime → TURN and copy the Token ID shown there (a separate hex id from your account).'
            : undefined,
        },
      })
      return this.cached?.servers ?? []
    }
    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error('Cloudflare TURN response not JSON', { meta: { error: msg } })
      return this.cached?.servers ?? []
    }
    const servers = parseCloudflareTurnResponse(body)
    if (servers.length === 0) {
      this.logger.error('Cloudflare TURN response had no usable ICE servers', {
        meta: { body: JSON.stringify(body).slice(0, 800) },
      })
      return this.cached?.servers ?? []
    }
    this.cached = { servers, fetchedAt: Date.now() }
    const totalUrls = servers.reduce((n, s) => n + (Array.isArray(s.urls) ? s.urls.length : 1), 0)
    const hasCredentials = servers.some((s) => s.username && s.credential)
    this.logger.info('Cloudflare TURN servers fetched', {
      meta: {
        serverCount: servers.length,
        urlCount: totalUrls,
        hasCredentials,
        ttlSeconds: TTL_SECONDS,
      },
    })
    return servers
  }
}
