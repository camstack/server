/**
 * Addon Widgets Aggregator — hub-local builtin that owns the singleton
 * `addon-widgets` cap.
 *
 * Mirrors `addon-pages-aggregator` exactly: walks every registered
 * `addon-widgets-source` (collection) provider and emits an enriched
 * widget metadata list with versioned `bundleUrl`s pointing at
 * `/api/addon-widgets/<addonId>/<bundle>?v=<contentHash>`. The
 * content-hash cache-buster lets the browser (and any caching proxy)
 * pick up addon rebuilds without manual reload — see `makeBundleUrl`
 * for why mtime is unusable (reproducible builds fix it).
 *
 * The static file endpoint (`/api/addon-widgets/:addonId/*`) is served
 * by `AddonWidgetsService.resolveBundle()` on the server side; this
 * addon only owns the listing surface.
 *
 * Why a builtin: same reasoning as `addon-pages-aggregator`. The
 * aggregator is the de-facto "addon-widgets provider" — addons own caps,
 * not the server. Living in `@camstack/system/builtins` keeps the surface
 * symmetrical with `system-config`, `local-auth`, etc.
 */
import * as path from 'node:path'
import * as fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import {
  BaseAddon,
  EventCategory,
  addonWidgetsCapability,
  errMsg,
  type IAddonWidgetsAggregatorProvider,
  type IAddonWidgetsSourceProvider,
  type ProviderRegistration,
} from '@camstack/types'
import { settleSourcesWithTimeout } from '../shared/settle-sources.js'

interface ResolvedPaths {
  readonly addonsDir: string
}

/**
 * Inferred from the cap definition — equivalent to:
 * `z.infer<typeof EnrichedWidgetMetadataSchema>` but reuses the
 * provider's return type so the aggregator stays in lockstep with the
 * cap if its shape evolves.
 */
type EnrichedWidget = Awaited<ReturnType<IAddonWidgetsAggregatorProvider['listWidgets']>>[number]
type RawWidget = Awaited<ReturnType<IAddonWidgetsSourceProvider['listWidgets']>>[number]

/**
 * Backoff schedule (ms) used to retry sources that failed during a
 * `listWidgets()` round-trip — typically because the cap was just
 * registered (provider connected via Moleculer) but the worker-side
 * action registration hadn't propagated yet, so `Service '...listWidgets'
 * is not found on '<node>'` raced ahead of the call.
 *
 * On success we re-emit `AddonWidgetReady` so admin-ui invalidates its
 * `addonWidgets.listWidgets` query and the registry populates without a
 * page reload.
 */
const RETRY_BACKOFF_MS: readonly number[] = [500, 1500, 4000]

/**
 * Per-source ceiling for a single `listWidgets()` round-trip. Mirrors the
 * addon-pages aggregator: a slow/unreachable source (e.g. an agent-hosted
 * widget source whose cap call sits in a Moleculer `waitForServices`) times
 * out fast and serves its cached snapshot instead of blocking the dashboard.
 */
const PER_SOURCE_TIMEOUT_MS = 2_500

export class AddonWidgetsAggregatorAddon extends BaseAddon {
  readonly id = 'addon-widgets-aggregator'

  private resolvedPaths: ResolvedPaths | null = null
  /** Content-hash cache-buster memo, keyed `path:size:mtime`. */
  private readonly bundleHashCache = new Map<string, string>()

  /**
   * Last successful `listWidgets()` snapshot per source. Used as the
   * "stale-but-valid" fallback when a source transiently fails — drops
   * happen often enough during boot (Moleculer service-discovery
   * window) that swallowing the error and returning empty would leave
   * the dashboard with nothing for several seconds. Keeping the
   * previous good entry means a flake is invisible to the operator.
   */
  private readonly lastGood = new Map<string, readonly EnrichedWidget[]>()

  /** In-flight retry guards keyed by sourceAddonId. Avoids double-scheduling. */
  private readonly retryTimers = new Map<string, NodeJS.Timeout>()

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.resolvedPaths = await this.resolvePaths()

    const provider: IAddonWidgetsAggregatorProvider = {
      listWidgets: async (): Promise<readonly EnrichedWidget[]> => this.aggregate(),
    }

    this.ctx.logger.info('Initialized — aggregating addon-widgets-source providers')
    return [{ capability: addonWidgetsCapability, provider }]
  }

  protected async onShutdown(): Promise<void> {
    for (const t of this.retryTimers.values()) clearTimeout(t)
    this.retryTimers.clear()
    this.lastGood.clear()
  }

  // ── Aggregation ───────────────────────────────────────────────────

  /**
   * Strip the `@<nodeId>` suffix that the CapabilityBridge appends to
   * collection-provider registry keys for cross-node addons (see
   * `moleculer.service.ts` — `registryKey = ${addonId}@${nodeId}`).
   *
   * The widget bundle is hub-resident (the same npm package ships to
   * every node and the hub keeps a copy on disk keyed by the bare
   * manifest id), so both the static-file URL and the admin-ui widget
   * namespace must use the bare addon id. Without this, a widget
   * source running on a remote agent yields a `bundleUrl` like
   * `/api/addon-widgets/pipeline-analytics@agent-0/pipeline-analytics/remoteEntry.js`
   * — the embedded `@<node>/<group>` makes the static-file route's
   * `:addonId` param mismatch the registered provider and 404.
   */
  private bareAddonId(registryKey: string): string {
    const at = registryKey.indexOf('@')
    return at === -1 ? registryKey : registryKey.slice(0, at)
  }

  private async aggregate(): Promise<readonly EnrichedWidget[]> {
    // `getCollectionEntries` returns `[addonId, provider]` tuples — the
    // raw `addon-widgets-source` cap doesn't carry an `id` on the
    // provider (unlike the legacy `IAddonPageProvider`), so we lean on
    // the registry to attribute each contribution back to its addon.
    const entries =
      this.capabilities?.getCollectionEntries<IAddonWidgetsSourceProvider>(
        'addon-widgets-source',
      ) ?? []
    const out: EnrichedWidget[] = []
    const seenIds = new Set<string>()

    // Fan out IN PARALLEL with a per-source timeout (see addon-pages
    // aggregator) so one slow/unreachable source can't stall listWidgets().
    // Bookkeeping keys on the full registry key so the same addon on multiple
    // nodes stays distinct; emitted metadata uses the bare id.
    const settled = await settleSourcesWithTimeout<RawWidget>(
      entries.map(
        ([registryKey, source]) =>
          [registryKey, () => Promise.resolve(source.listWidgets())] as const,
      ),
      PER_SOURCE_TIMEOUT_MS,
    )

    for (const [addonId, result] of settled) {
      const publicAddonId = this.bareAddonId(addonId)
      seenIds.add(addonId)
      if (result.ok) {
        const enriched: EnrichedWidget[] = result.value.map((w: RawWidget) => ({
          ...w,
          addonId: publicAddonId,
          bundleUrl: this.makeBundleUrl(publicAddonId, w.bundle),
        }))
        for (const item of enriched) out.push(item)
        // Cache successful snapshot — used as fallback on next failure.
        this.lastGood.set(addonId, enriched)
      } else {
        this.ctx.logger.warn('addon-widgets-source provider failed', {
          meta: { sourceId: addonId, error: result.error.message },
        })
        // Fall back to the last-good snapshot so a transient failure doesn't
        // blank the dashboard.
        const cached = this.lastGood.get(addonId)
        if (cached !== undefined) {
          for (const item of cached) out.push(item)
          this.ctx.logger.info('addon-widgets-source falling back to cached snapshot', {
            meta: { sourceId: addonId, cachedWidgets: cached.length },
          })
        }
        // Schedule a background retry. On success we re-emit
        // `AddonWidgetReady` so admin-ui's queryClient invalidates and
        // any newly-loaded widgets show up without a manual reload.
        this.scheduleRetry(addonId)
      }
    }

    // Drop cache entries for sources that have disappeared from the
    // registry — keeps the fallback aligned with the live collection.
    for (const cachedId of this.lastGood.keys()) {
      if (!seenIds.has(cachedId)) this.lastGood.delete(cachedId)
    }

    return out
  }

  // ── Retry on transient Moleculer race ─────────────────────────────

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
    const entries =
      this.capabilities?.getCollectionEntries<IAddonWidgetsSourceProvider>(
        'addon-widgets-source',
      ) ?? []
    const found = entries.find(([id]) => id === sourceId)
    if (!found) return // provider went away; nothing to retry
    const [addonId, source] = found
    const publicAddonId = this.bareAddonId(addonId)

    try {
      const widgets = await Promise.resolve(source.listWidgets())
      const enriched: EnrichedWidget[] = widgets.map((w: RawWidget) => ({
        ...w,
        addonId: publicAddonId,
        bundleUrl: this.makeBundleUrl(publicAddonId, w.bundle),
      }))
      this.lastGood.set(addonId, enriched)
      this.ctx.logger.info('addon-widgets-source recovered after retry', {
        meta: { sourceId: addonId, attempt: attempt + 1, widgets: enriched.length },
      })
      // Re-emit AddonWidgetReady so admin-ui invalidates and refetches.
      this.ctx.eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'addon', id: this.id },
        category: EventCategory.AddonWidgetReady,
        data: { addonId: publicAddonId, recovered: true },
      })
    } catch (err: unknown) {
      this.ctx.logger.debug('addon-widgets-source retry failed', {
        meta: { sourceId, attempt: attempt + 1, error: errMsg(err) },
      })
      this.scheduleRetry(sourceId, attempt + 1)
    }
  }

  // ── Bundle URL stamping ──────────────────────────────────────────

  /**
   * Build `/api/addon-widgets/<addonId>/<bundle>?v=<mtime>`. Falls back
   * to `Date.now()` when the bundle path can't be stat'd (remote addon
   * with no local file, addon not yet on disk, etc.) — the browser
   * just gets a fresh URL on each call instead of cache-friendly mtime.
   */
  private makeBundleUrl(addonId: string, bundle: string): string {
    const bundlePath = this.resolveBundlePath(addonId, bundle)
    // CONTENT-VERSIONED PATH, not a `?v=` query. Module-Federation bundles
    // import fixed-name siblings by RELATIVE url (`./_stub.js`,
    // `./remoteEntry`) which do NOT inherit a query on the entry, so a `?v=`
    // busts only the entry — a caching proxy (Cloudflare) keeps serving a
    // stale `_stub.js` whose export map lacks the newest widget. Putting the
    // version in the PATH prefix makes every relative import inherit it, so
    // one build = one namespace = an atomic cache-miss of the WHOLE bundle,
    // on any CDN, with no proxy config. And the tag hashes the ENTIRE bundle
    // DIR (not just the entry) so a `_stub.js`-only change — imported by a
    // fixed name that never propagates to the entry hash — still busts.
    const v = this.bundleDirVersionTag(bundlePath)
    return `/api/addon-widgets/${addonId}/v${v}/${bundle}`
  }

  /**
   * sha1 (12-hex) over EVERY file in the bundle's dist dir — content, not
   * mtime (reproducible builds fix mtime, so mtime never busts). Memoised by
   * the dir's (name:size:mtime) fingerprint; a redeploy that changes any
   * file's content changes its size and re-hashes. `Date.now()` when the
   * bundle has no local file (remote addon).
   */
  private bundleDirVersionTag(entryPath: string | null): string {
    if (entryPath === null) return String(Math.floor(Date.now()))
    try {
      const dir = path.dirname(entryPath)
      const files = fs
        .readdirSync(dir)
        .filter((f) => fs.statSync(path.join(dir, f)).isFile())
        .sort()
      const fingerprint = files
        .map((f) => {
          const s = fs.statSync(path.join(dir, f))
          return `${f}:${s.size}:${s.mtimeMs}`
        })
        .join('|')
      const cacheKey = `${dir}#${fingerprint}`
      const cached = this.bundleHashCache.get(cacheKey)
      if (cached !== undefined) return cached
      const hash = createHash('sha1')
      for (const f of files) {
        hash.update(f)
        hash.update(fs.readFileSync(path.join(dir, f)))
      }
      const digest = hash.digest('hex').slice(0, 12)
      this.bundleHashCache.set(cacheKey, digest)
      return digest
    } catch {
      return String(Math.floor(Date.now()))
    }
  }

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

export default AddonWidgetsAggregatorAddon
