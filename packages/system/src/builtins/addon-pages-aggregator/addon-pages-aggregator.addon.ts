/**
 * Addon Pages Aggregator — hub-local builtin that owns the singleton
 * `addon-pages` cap.
 *
 * Walks every registered `addon-pages-source` (collection) provider and
 * emits an enriched `AddonPageInfo[]` list with versioned `bundleUrl`s
 * pointing at `/api/addon-pages/<addonId>/<bundle>?v=<mtime>`. The
 * filesystem `mtime` cache-buster lets the browser pick up addon
 * rebuilds without manual reload — same scheme the original
 * hand-written `AddonPagesService.listPages` used before this split.
 *
 * The static file endpoint (`/api/addon-pages/:addonId/*`) is still
 * served by `AddonPagesService.resolveBundle()` on the server side; this
 * addon only owns the listing surface.
 *
 * Why a builtin rather than a cap-providers helper:
 *   - The aggregator is conceptually the "addon-pages provider" — addons
 *     own caps, not the server. Living in `@camstack/system/builtins` keeps
 *     the surface symmetrical with `system-config`, `local-auth`, etc.
 *   - Lets the aggregator subscribe to source readiness without piping a
 *     CapabilityRegistry handle through `RouterServices`.
 */
import * as path from 'node:path'
import * as fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import {
  BaseAddon,
  EventCategory,
  addonPagesCapability,
  errMsg,
  type AddonPageInfo,
  type IAddonPageProvider,
  type IAddonPagesAggregatorProvider,
  type ProviderRegistration,
} from '@camstack/types'
import { settleSourcesWithTimeout } from '../shared/settle-sources.js'
import { dedupePages } from './dedupe-pages.js'

interface ResolvedPaths {
  readonly addonsDir: string
}

/**
 * Backoff schedule (ms) used to retry sources that failed during a
 * `listPages()` round-trip — typically because the cap was just
 * registered (provider connected via Moleculer) but the worker-side
 * action registration hadn't propagated yet, so `Service '...listPages'
 * is not found on '<node>'` raced ahead of the call.
 *
 * We schedule one retry per entry; if every retry fails we stop
 * (the next aggregate() run will pick the source up again). On
 * success we re-emit `AddonPageReady` so admin-ui invalidates its
 * `addonPages.listPages` query and the sidebar populates without a
 * page reload.
 */
const RETRY_BACKOFF_MS: readonly number[] = [500, 1500, 4000]

/**
 * Per-source ceiling for a single `listPages()` round-trip. A healthy
 * source answers in well under this (hub-local UDS <100ms, a reachable
 * remote agent <1s). A source that's unreachable — e.g. an agent-hosted
 * addon whose cap routes through a Moleculer `waitForServices` that waits
 * its full 30s discovery timeout for a node that will never appear — must
 * NOT block the whole listing: we time it out fast, serve its cached
 * snapshot, and let the background retry recover it. Combined with the
 * parallel fan-out below, one slow/dead source can no longer stall the
 * sidebar query (which otherwise hangs long enough to trip the WS
 * keepalive → "server unreachable").
 */
const PER_SOURCE_TIMEOUT_MS = 2_500

export class AddonPagesAggregatorAddon extends BaseAddon {
  readonly id = 'addon-pages-aggregator'

  private resolvedPaths: ResolvedPaths | null = null
  /** Content-hash cache-buster memo, keyed `path:size:mtime`. */
  private readonly bundleHashCache = new Map<string, string>()

  /**
   * Last successful `listPages()` snapshot per source. Used as the
   * "stale-but-valid" fallback when a source transiently fails — drops
   * happen often enough during boot (Moleculer service-discovery
   * window) that swallowing the error and returning empty leaves the
   * sidebar with nothing for several seconds. Keeping the previous
   * good entry means a flake is invisible to the operator.
   */
  private readonly lastGood = new Map<string, readonly AddonPageInfo[]>()

  /** In-flight retry guards keyed by sourceId. Avoids double-scheduling. */
  private readonly retryTimers = new Map<string, NodeJS.Timeout>()

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.resolvedPaths = await this.resolvePaths()

    const provider: IAddonPagesAggregatorProvider = {
      listPages: async (): Promise<readonly AddonPageInfo[]> => this.aggregate(),
    }

    this.ctx.logger.info('Initialized — aggregating addon-pages-source providers')
    return [{ capability: addonPagesCapability, provider }]
  }

  protected async onShutdown(): Promise<void> {
    for (const t of this.retryTimers.values()) clearTimeout(t)
    this.retryTimers.clear()
    this.lastGood.clear()
  }

  // ── Aggregation ───────────────────────────────────────────────────

  private async aggregate(): Promise<readonly AddonPageInfo[]> {
    const sources = this.capabilities?.getCollection<IAddonPageProvider>('addon-pages-source') ?? []
    const out: AddonPageInfo[] = []
    const seenIds = new Set<string>()

    // Fan out to every source IN PARALLEL with a per-source timeout. A slow
    // or unreachable source (e.g. an agent-hosted source whose cap call sits
    // in a 30s Moleculer waitForServices) times out fast and falls back to
    // its cached snapshot instead of blocking the whole listing — which would
    // otherwise hang the sidebar query long enough to trip the WS keepalive.
    const settled = await settleSourcesWithTimeout<AddonPageInfo['page']>(
      sources.map((source) => [source.id, () => Promise.resolve(source.listPages())] as const),
      PER_SOURCE_TIMEOUT_MS,
    )

    for (const [sourceId, result] of settled) {
      seenIds.add(sourceId)
      if (result.ok) {
        const enriched: AddonPageInfo[] = result.value.map((page) => ({
          addonId: sourceId,
          page,
          bundleUrl: this.makeBundleUrl(sourceId, page.bundle),
        }))
        for (const item of enriched) out.push(item)
        // Cache successful snapshot — used as fallback on next failure.
        this.lastGood.set(sourceId, enriched)
      } else {
        this.ctx.logger.warn('addon-pages-source provider failed', {
          meta: { sourceId, error: result.error.message },
        })
        // Fall back to the last-good snapshot for this source so a transient
        // failure (Moleculer service-discovery race, slow source) doesn't
        // blank the sidebar.
        const cached = this.lastGood.get(sourceId)
        if (cached !== undefined) {
          for (const item of cached) out.push(item)
          this.ctx.logger.info('addon-pages-source falling back to cached snapshot', {
            meta: { sourceId, cachedPages: cached.length },
          })
        }
        // Schedule a background retry. On success we re-emit `AddonPageReady`
        // so admin-ui's queryClient invalidates and any newly-loaded pages
        // show up without a manual reload.
        this.scheduleRetry(sourceId)
      }
    }

    // Drop cache entries for sources that have disappeared from the
    // registry — keeps the fallback aligned with the live collection.
    for (const cachedId of this.lastGood.keys()) {
      if (!seenIds.has(cachedId)) this.lastGood.delete(cachedId)
    }

    // Collapse the same addon's page when it's deployed on more than one
    // node. `addon-pages-source` is a COLLECTION cap, so an addon running on
    // both the hub-local child and a remote agent registers one provider per
    // node — each reporting the SAME addon id + page declaration. Without
    // this, the sidebar lists the page once per node (the "two Benchmark
    // pages" bug). Dedup by `(addonId, page.id)`, keeping the first (the
    // hub-local provider precedes remote ones in fan-out order).
    return dedupePages(out)
  }

  // ── Retry on transient Moleculer race ─────────────────────────────

  /**
   * Schedule background re-call of `listPages()` on a source that just
   * failed. Walks `RETRY_BACKOFF_MS` from index 0 — each successful
   * call updates the cache and emits `AddonPageReady` so the admin UI
   * invalidates its query. Stops on first success or after the schedule
   * is exhausted.
   */
  private scheduleRetry(sourceId: string, attempt = 0): void {
    if (attempt >= RETRY_BACKOFF_MS.length) return
    if (this.retryTimers.has(sourceId)) return // already pending

    const delayMs = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!
    const timer = setTimeout(() => {
      this.retryTimers.delete(sourceId)
      void this.retrySource(sourceId, attempt)
    }, delayMs)
    this.retryTimers.set(sourceId, timer)
  }

  private async retrySource(sourceId: string, attempt: number): Promise<void> {
    const sources = this.capabilities?.getCollection<IAddonPageProvider>('addon-pages-source') ?? []
    const source = sources.find((s) => s.id === sourceId)
    if (!source) return // provider went away; nothing to retry

    try {
      const pages = await Promise.resolve(source.listPages())
      const enriched: AddonPageInfo[] = pages.map((page) => ({
        addonId: source.id,
        page,
        bundleUrl: this.makeBundleUrl(source.id, page.bundle),
      }))
      this.lastGood.set(source.id, enriched)
      this.ctx.logger.info('addon-pages-source recovered after retry', {
        meta: { sourceId, attempt: attempt + 1, pages: enriched.length },
      })
      // Re-emit AddonPageReady so admin-ui invalidates and refetches.
      this.ctx.eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'addon', id: this.id },
        category: EventCategory.AddonPageReady,
        data: { addonId: sourceId, recovered: true },
      })
    } catch (err: unknown) {
      this.ctx.logger.debug('addon-pages-source retry failed', {
        meta: { sourceId, attempt: attempt + 1, error: errMsg(err) },
      })
      this.scheduleRetry(sourceId, attempt + 1)
    }
  }

  // ── Bundle URL stamping ──────────────────────────────────────────

  /**
   * Build `/api/addon-pages/<addonId>/<bundle>?v=<contentHash>`. A CONTENT
   * hash, NOT mtime: reproducible builds stamp a FIXED mtime (observed
   * 1985-10-26) so an mtime `?v=` never changes across redeploys and a
   * caching proxy (Cloudflare tunnel) serves a STALE bundle. Hashing the
   * (small) MF entry file busts the cache exactly when the bundle changes.
   * Memoised per (path,size,mtime); `Date.now()` when the file is absent.
   */
  private makeBundleUrl(addonId: string, bundle: string): string {
    const bundlePath = this.resolveBundlePath(addonId, bundle)
    if (bundlePath === null) {
      return `/api/addon-pages/${addonId}/${bundle}?v=${Math.floor(Date.now())}`
    }
    try {
      const stat = fs.statSync(bundlePath)
      const cacheKey = `${bundlePath}:${stat.size}:${stat.mtimeMs}`
      let v = this.bundleHashCache.get(cacheKey)
      if (v === undefined) {
        v = createHash('sha1').update(fs.readFileSync(bundlePath)).digest('hex').slice(0, 12)
        this.bundleHashCache.set(cacheKey, v)
      }
      return `/api/addon-pages/${addonId}/${bundle}?v=${v}`
    } catch {
      return `/api/addon-pages/${addonId}/${bundle}?v=${Math.floor(Date.now())}`
    }
  }

  /**
   * Resolve the local filesystem path for an addon's bundle. Mirrors
   * `AddonPagesService.resolveBundle` (server-side), but without the
   * existence / traversal checks — those still live on the server's
   * static file route. We only need a stat-able path here for the
   * `mtime` cache-buster.
   */
  private resolveBundlePath(addonId: string, bundle: string): string | null {
    const paths = this.resolvedPaths
    if (!paths) return null
    const addonDistPath = path.join(paths.addonsDir, '@camstack', `addon-${addonId}`, 'dist')
    const resolvedBase = path.resolve(addonDistPath)
    const resolvedFile = path.resolve(addonDistPath, bundle)
    if (!resolvedFile.startsWith(resolvedBase + path.sep) && resolvedFile !== resolvedBase) {
      return null
    }
    return resolvedFile
  }

  // ── Path resolution ──────────────────────────────────────────────

  /**
   * Read `server.dataPath` from the cluster yml-backed sections (same
   * source the server uses at boot), then derive the addons directory
   * from it. Falls back to `camstack-data/addons` when no settings API
   * is available — agents and isolated tests don't see this addon, so
   * the fallback is purely defensive.
   */
  private async resolvePaths(): Promise<ResolvedPaths> {
    const fallback: ResolvedPaths = { addonsDir: path.resolve('camstack-data', 'addons') }
    if (!this.ctx.settings) return fallback
    try {
      const server = await this.ctx.settings.getSection('server')
      const dataPath =
        typeof server['dataPath'] === 'string' && server['dataPath']
          ? server['dataPath']
          : 'camstack-data'
      return { addonsDir: path.resolve(dataPath, 'addons') }
    } catch (err: unknown) {
      this.ctx.logger.debug('Failed to read server.dataPath — falling back', {
        meta: { error: errMsg(err) },
      })
      return fallback
    }
  }
}

export default AddonPagesAggregatorAddon
