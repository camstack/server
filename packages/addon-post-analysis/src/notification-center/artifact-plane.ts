/**
 * The NC artifact plane: a PUBLIC data-plane route whose only authority is the
 * signature on the URL, plus the resolver that decides which base URL a link
 * should carry.
 *
 * Public is not a slip: the fetcher is a notifier backend or the recipient's
 * phone, neither of which holds a session. Authority therefore lives in the
 * link — HMAC over `(id, exp)`, expiring on its own, minted only by the
 * dispatcher for media it just produced. See `artifact-url.ts`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IScopedLogger } from '@camstack/types'
import { isAppLinkBase } from '@camstack/types'
import type { NcArtifactIndex, NcArtifactPublishMeta } from './artifact-index.js'
import type { NcArtifactStore } from './artifact-store.js'
import {
  type ArtifactEndpoint,
  buildArtifactUrl,
  pickArtifactBaseUrl,
  verifyArtifactSignature,
} from './artifact-url.js'

export interface NcArtifactPlaneDeps {
  readonly store: NcArtifactStore
  readonly secret: string
  readonly logger: IScopedLogger
  /**
   * The viewer's browsable index (task #36). Absent ⇒ nothing is retained and
   * nothing is indexed: {@link NcArtifactPlane.publishIndexed} degrades to a
   * plain scratch publish, so a node without the index still delivers
   * notifications with media.
   */
  readonly index?: NcArtifactIndex
  /**
   * The ranked candidate base URLs, best first. The wiring builds this with
   * {@link collectArtifactEndpoints}: the hub's public endpoint (D734), then
   * the connected ingress and the LAN addresses for when that is unknown.
   * Loopback is refused downstream rather than shipped as an unopenable link.
   */
  readonly listEndpoints: () => Promise<readonly ArtifactEndpoint[]>
  /** The served route prefix, e.g. `/addon/pipeline-analytics/nc-artifact`. */
  readonly routePrefix: string
  /** How long a minted link stays valid. Default 24 h. */
  readonly ttlMs?: number
  readonly now?: () => number
  /** Endpoint cache TTL — the interface list barely moves. Default 60 s. */
  readonly endpointCacheMs?: number
}

/**
 * The hub's default HTTPS API port — the same constant `derive-hub-url.ts`
 * documents. Only a legacy hint for the LAN candidates: `local-network`
 * builds them with the port the hub really listens on.
 */
export const HUB_API_PORT = 4443

/**
 * Ranking of the public sources. All NEGATIVE: `local-network` gives its
 * preferred LAN interface priority `0`, so a public candidate has to sit below
 * zero to outrank it.
 */
const PRIORITY_PUBLIC_ENDPOINT = -400
const PRIORITY_CONNECTED = -200
const PRIORITY_EXTERNAL_LIST = -100

/**
 * Build the ranked candidate list for every link a notification carries
 * (buttons, attachments / media, admin links): the hub's PUBLIC ENDPOINT
 * (D734), then — only reached when that is unknown — the connected external
 * ingress (tunnels), then the LAN addresses. Every source is best-effort — one
 * that throws contributes nothing rather than costing the whole list.
 *
 * The notification-taps address is deliberately NOT an input: it decides only
 * where a tap opens, and its default (the app link) is no hub address.
 */
export async function collectArtifactEndpoints(sources: {
  /**
   * The hub's `publicEndpoint` role (`local-network.getAddresses().roles
   * .publicEndpoint.resolved`): the address flagged on the Network page, else
   * the automatic tunnel → mesh → LAN pick. Outranks every other source.
   */
  readonly publicEndpoint?: string | undefined
  /**
   * The CONNECTED single ingress (`network-access.getStatus().endpoint`).
   * This is the primary public source, not `listEndpoints`: the cap documents
   * that "providers that expose only ONE endpoint just omit `listEndpoints`",
   * and the common case (one tunnel) is exactly that — the live hub had a
   * connected `https://…` tunnel while `listEndpoints` answered `[]`, so the
   * first artifact link went out on the LAN address (2026-07-30).
   */
  readonly getConnected: () => Promise<{ url: string; protocol: string } | null>
  readonly listExternal: () => Promise<readonly { url: string; protocol: string }[]>
  readonly listLan: (port: number) => Promise<readonly ArtifactEndpoint[]>
  readonly logger: IScopedLogger
}): Promise<readonly ArtifactEndpoint[]> {
  const out: ArtifactEndpoint[] = []
  const publicEndpoint = sources.publicEndpoint
  // The hub refuses the app link for this role; refused here too, because a
  // signed media link or an action button minted on it would 404 at the
  // central domain. Only taps take the app form (`default-tap-url.ts`).
  if (publicEndpoint !== undefined && publicEndpoint !== '' && !isAppLinkBase(publicEndpoint)) {
    out.push({ baseUrl: publicEndpoint, kind: 'public', priority: PRIORITY_PUBLIC_ENDPOINT })
  }
  try {
    const connected = await sources.getConnected()
    if (connected !== null && connected.protocol === 'https') {
      out.push({ baseUrl: connected.url, kind: 'public', priority: PRIORITY_CONNECTED })
    }
  } catch (err) {
    sources.logger.debug('connected endpoint lookup failed', { meta: { error: String(err) } })
  }
  try {
    const external = await sources.listExternal()
    for (const [i, e] of external.entries()) {
      if (e.protocol !== 'https') continue
      out.push({ baseUrl: e.url, kind: 'public', priority: PRIORITY_EXTERNAL_LIST + i })
    }
  } catch (err) {
    sources.logger.debug('external endpoint lookup failed', { meta: { error: String(err) } })
  }
  try {
    out.push(...(await sources.listLan(HUB_API_PORT)))
  } catch (err) {
    sources.logger.debug('LAN endpoint lookup failed', { meta: { error: String(err) } })
  }
  return out
}

const DEFAULT_TTL_MS = 24 * 3600_000
const DEFAULT_ENDPOINT_CACHE_MS = 60_000

/**
 * What an indexed publish answers. The two members fail INDEPENDENTLY: an
 * install with no reachable public address still indexes (`url: null`), and a
 * node with no index still mints a link (`artifactId: null`).
 */
export interface NcArtifactPublication {
  /** Signed, externally-fetchable URL for a notifier backend. */
  readonly url: string | null
  /** The store id — the handle the viewer's authenticated route resolves. */
  readonly artifactId: string | null
}

export class NcArtifactPlane {
  private readonly now: () => number
  private cachedBaseUrl: string | null = null
  /** Last base URL announced in the log — so the line appears on CHANGE only. */
  private lastLoggedBaseUrl: string | null = null
  private cachedAt = 0

  constructor(private readonly deps: NcArtifactPlaneDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  /**
   * Store bytes and mint a signed, externally-reachable URL for them.
   * Returns `null` when no usable base URL exists (loopback only) — the caller
   * then ships bytes alone, exactly as before. Never throws: an artifact URL is
   * an ENHANCEMENT, and failing to mint one must not cost the notification.
   *
   * `deviceId` decides which camera bucket the bytes file under in the
   * eventMedia class — pass it whenever the caller knows the camera, or the
   * artifact lands unattributed in the `0` bucket.
   */
  async publish(bytes: Uint8Array, mime: string, deviceId?: number | null): Promise<string | null> {
    try {
      const baseUrl = await this.resolveBaseUrl()
      if (baseUrl === null) return null
      const artifact = await this.deps.store.put(bytes, mime, { deviceId: deviceId ?? null })
      return buildArtifactUrl({
        baseUrl,
        routePrefix: this.deps.routePrefix,
        id: artifact.id,
        secret: this.deps.secret,
        expMs: this.now() + (this.deps.ttlMs ?? DEFAULT_TTL_MS),
      })
    } catch (err) {
      this.deps.logger.debug('artifact publish failed — shipping bytes only', {
        meta: { error: String(err) },
      })
      return null
    }
  }

  /**
   * Publish bytes AND file them in the viewer's browsable index (task #36).
   *
   * Two differences from {@link publish}, both deliberate:
   *
   * 1. **The bytes are stored FIRST, and stored even when no public base URL
   *    exists.** `publish` returns early on a loopback-only install because a
   *    signed link nobody can open is worth nothing — but the VIEWER reaches
   *    the hub directly over its own session, so an install with no tunnel
   *    still gets a full artifact library. Making the index depend on a
   *    reachable public address would have made the feature absent exactly on
   *    the installs that are LAN-only.
   * 2. **It answers the artefact id**, so a caller can link one artefact to
   *    another — a timelapse's poster is its preview frame, and the video row
   *    cannot name it without knowing the id the preview got.
   *
   * Never throws, for the same reason `publish` does not: an artefact library
   * is an enhancement and must never cost a notification.
   */
  async publishIndexed(
    bytes: Uint8Array,
    mime: string,
    meta: NcArtifactPublishMeta,
  ): Promise<NcArtifactPublication> {
    let artifactId: string | null = null
    try {
      const index = this.deps.index
      const stored = await this.deps.store.put(bytes, mime, {
        retain: index !== undefined,
        deviceId: meta.deviceId,
      })
      if (index !== undefined) {
        const recorded = await index.record({
          ...meta,
          id: stored.id,
          mime,
          sizeBytes: stored.bytes,
        })
        artifactId = recorded?.id ?? null
      }
      const baseUrl = await this.resolveBaseUrl()
      const url =
        baseUrl === null
          ? null
          : buildArtifactUrl({
              baseUrl,
              routePrefix: this.deps.routePrefix,
              id: stored.id,
              secret: this.deps.secret,
              expMs: this.now() + (this.deps.ttlMs ?? DEFAULT_TTL_MS),
            })
      return { url, artifactId }
    } catch (err) {
      this.deps.logger.warn('indexed artifact publish failed — shipping bytes only', {
        ...(meta.deviceId !== null ? { tags: { deviceId: meta.deviceId } } : {}),
        meta: { kind: meta.kind, error: String(err) },
      })
      return { url: null, artifactId }
    }
  }

  /**
   * Mint a FRESH signed URL for an artefact already sitting on the shelf —
   * no bytes read, no re-store. The other half of {@link publishIndexed}: that
   * one stores AND mints once at publish time; this one re-mints on demand for
   * an id a caller already holds (a history row's `artifactIds`), because the
   * link `publishIndexed` returned has its own TTL and a caller reaching for
   * the artefact hours later needs a new one.
   *
   * `null` on any of three causes, deliberately indistinguishable to the
   * caller: no index is wired (nothing to resolve against), the id is unknown
   * or its artefact has expired past the retained shelf's own age bound, or no
   * externally-reachable base URL exists for this install. A caller (the Home
   * Assistant export) must render all three as "no image right now" — never as
   * a broken link, and never by reusing a URL this call refused to mint.
   */
  async mintUrl(artifactId: string): Promise<string | null> {
    const index = this.deps.index
    if (index === undefined) return null
    try {
      const record = await index.resolve(artifactId)
      if (record === null) return null
      // Expiry is derived from the shelf's own age bound (`NcArtifactIndex`'s
      // header note) — a record past it may still be sitting in the store for
      // a few more seconds before the next prune pass, and minting a link to
      // it would be a URL that dies mid-flight rather than one that never
      // worked. Checked here explicitly rather than trusted to `resolve`,
      // which answers the BYTES route's question ("is this id indexed at
      // all") and not this one ("is it still meant to exist").
      if (record.expiresAt <= this.now()) return null
      const baseUrl = await this.resolveBaseUrl()
      if (baseUrl === null) return null
      return buildArtifactUrl({
        baseUrl,
        routePrefix: this.deps.routePrefix,
        id: artifactId,
        secret: this.deps.secret,
        expMs: this.now() + (this.deps.ttlMs ?? DEFAULT_TTL_MS),
      })
    } catch (err) {
      this.deps.logger.debug('artifact url mint failed', {
        meta: { artifactId, error: String(err) },
      })
      return null
    }
  }

  /**
   * Absolutize a path against the SAME base URL an artifact link would use.
   *
   * For links this plane does not host but a RECIPIENT still has to open — a
   * recorder export download, served `access: 'authenticated'`. It is not
   * signed and it is not public: it is a tap-through the person opens where
   * they already hold a session, which is why it goes on `clickUrl` and never
   * on an attachment.
   *
   * Reuses `resolveBaseUrl` rather than re-deriving one, because "which
   * address can the recipient actually reach" is a question this repo has
   * already answered wrongly once (the first artifact link went out on the LAN
   * address while a tunnel was connected).
   */
  async resolveExternalUrl(pathname: string): Promise<string | null> {
    const baseUrl = await this.resolveBaseUrl().catch(() => null)
    if (baseUrl === null) return null
    return `${baseUrl.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`
  }

  /** The data-plane handler for `<prefix>/<id>?exp=&sig=`. */
  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const id = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
    const ok = verifyArtifactSignature({
      secret: this.deps.secret,
      id,
      exp: Number(url.searchParams.get('exp')),
      sig: url.searchParams.get('sig') ?? '',
      nowMs: this.now(),
    })
    if (!ok) {
      // One status for "bad signature", "expired" and "unknown id": a public
      // route that distinguishes them is an oracle.
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    const found = await this.deps.store.read(id)
    if (found === null) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': found.mime,
      'content-length': String(found.bytes.byteLength),
      // Immutable for as long as the link lives — a notification image is
      // fetched once by the backend and possibly again by the recipient.
      'cache-control': 'private, max-age=3600',
    })
    res.end(found.bytes)
  }

  /** The chosen base URL, cached briefly (the interface list barely moves). */
  private async resolveBaseUrl(): Promise<string | null> {
    const ttl = this.deps.endpointCacheMs ?? DEFAULT_ENDPOINT_CACHE_MS
    if (this.cachedBaseUrl !== null && this.now() - this.cachedAt < ttl) return this.cachedBaseUrl
    const endpoints = await this.deps.listEndpoints()
    const picked = pickArtifactBaseUrl(endpoints)
    if (picked === null) {
      this.deps.logger.debug('no externally-reachable endpoint — artifacts ship as bytes only')
      return null
    }
    // Log the CHOSEN value, not just the candidates: which host a link is
    // minted with was the single hardest thing to establish all session (the
    // candidate list said "tunnel" while the ranking still picked the LAN).
    if (picked !== this.lastLoggedBaseUrl) {
      this.deps.logger.info('artifact links will use', { meta: { baseUrl: picked } })
      this.lastLoggedBaseUrl = picked
    }
    this.cachedBaseUrl = picked
    this.cachedAt = this.now()
    return picked
  }
}
