/**
 * Per-integration Wyze cloud client registry (account mode).
 *
 * Under the LOCKED integration/adoption model, Wyze is a `mode: account`
 * addon: each Wyze integration carries its own account credentials in its
 * `integration.settings`, and this registry holds one
 * {@link WyzeCloudClient} per `integrationId`
 * (`Map<integrationId, WyzeCloudClient>`). Multi-account = multiple
 * integrations; there is NO shared broker.
 *
 * Each client's persisted session lives under a per-integration
 * subdirectory of `dataDir` so two accounts never clobber each other's
 * `wyze-session.json`.
 *
 * The registry also owns a per-integration camera-list cache (debounced to
 * respect Wyze's auth rate-limit) so both the adoption provider and the
 * live cameras read a single shared, rate-safe list per account.
 */

import { join } from 'node:path'
import type { WyzeCamera } from '@apocaliss92/wyze-bridge-js'
import type { IScopedLogger } from '@camstack/types'
import { WyzeCloudClient } from './cloud-client.js'
import type { WyzeCredentials } from './cloud-client.js'
import { classifyCloudError } from './error-classifier.js'
import type { ClassifiedWyzeError } from './error-classifier.js'

const CAMERA_LIST_REFRESH_MS = 5 * 60_000

/** One integration's live client + its rate-safe camera-list cache. */
interface WyzeClientEntry {
  readonly client: WyzeCloudClient
  readonly credentials: WyzeCredentials
  cameraListCache: readonly WyzeCamera[]
  cameraListFetchedAt: number
  cameraListInFlight: Promise<readonly WyzeCamera[]> | null
  /** Last classified error from a getCameraList fetch failure, or null on success. */
  lastFetchError: ClassifiedWyzeError | null
}

export interface WyzeClientRegistryDeps {
  /** Addon data dir; per-integration sessions live under `<dataDir>/<id>`. */
  readonly dataDir: string
  readonly logger: IScopedLogger
}

/** True when two credential blobs are identical (session-preserving reconcile). */
function sameCredentials(a: WyzeCredentials, b: WyzeCredentials): boolean {
  return (
    a.email === b.email && a.password === b.password && a.apiKey === b.apiKey && a.apiId === b.apiId
  )
}

/**
 * Owns the `Map<integrationId, WyzeCloudClient>`. Callers reconcile the map
 * against the live integration list on boot + on every integration lifecycle
 * event; device classes + the adoption provider resolve their client by
 * `integrationId`.
 */
export class WyzeClientRegistry {
  readonly #entries: Map<string, WyzeClientEntry> = new Map()
  readonly #deps: WyzeClientRegistryDeps

  constructor(deps: WyzeClientRegistryDeps) {
    this.#deps = deps
  }

  /**
   * Ensure a client exists for `integrationId` with the given credentials.
   * Idempotent: an existing entry with identical credentials is preserved
   * (keeps its live session + cache); a credentials change rebuilds it.
   */
  upsert(integrationId: string, credentials: WyzeCredentials): void {
    const existing = this.#entries.get(integrationId)
    if (existing && sameCredentials(existing.credentials, credentials)) return
    const client = new WyzeCloudClient({
      dataDir: join(this.#deps.dataDir, 'integrations', integrationId),
      logger: this.#deps.logger.child(`cloud:${integrationId}`),
      credentials,
    })
    this.#entries.set(integrationId, {
      client,
      credentials,
      cameraListCache: [],
      cameraListFetchedAt: 0,
      cameraListInFlight: null,
      lastFetchError: null,
    })
  }

  /** Drop the client for an integration that no longer exists / was disabled. */
  remove(integrationId: string): void {
    this.#entries.delete(integrationId)
  }

  /** Replace the whole set with `keep` — removes any client not in the set. */
  retain(keep: ReadonlySet<string>): void {
    for (const id of [...this.#entries.keys()]) {
      if (!keep.has(id)) this.#entries.delete(id)
    }
  }

  /** The live client for an integration, or null when unknown. */
  client(integrationId: string): WyzeCloudClient | null {
    return this.#entries.get(integrationId)?.client ?? null
  }

  /** True when a client is registered for the integration. */
  has(integrationId: string): boolean {
    return this.#entries.has(integrationId)
  }

  /** The registered integration ids (one per account). */
  list(): readonly string[] {
    return [...this.#entries.keys()]
  }

  /** Remove all clients (full shutdown). */
  clear(): void {
    this.#entries.clear()
  }

  /**
   * The last classified error from a `getCameraList` fetch failure for an
   * integration, or null when the last fetch succeeded (or no fetch has run
   * yet). Used by `getStatus` to surface the reason for an empty adoption list.
   */
  getLastFetchError(integrationId: string): ClassifiedWyzeError | null {
    return this.#entries.get(integrationId)?.lastFetchError ?? null
  }

  /**
   * Cloud camera list for ONE integration, cached + debounced + single-flight
   * to avoid auth rate-limits. Returns the last cache (possibly empty) when the
   * integration is unknown or the fetch fails.
   */
  async getCameraList(integrationId: string, force = false): Promise<readonly WyzeCamera[]> {
    const entry = this.#entries.get(integrationId)
    if (!entry) return []
    const fresh = Date.now() - entry.cameraListFetchedAt < CAMERA_LIST_REFRESH_MS
    if (!force && fresh && entry.cameraListCache.length > 0) return entry.cameraListCache
    if (entry.cameraListInFlight) return entry.cameraListInFlight
    const run = entry.client
      .getCameraList()
      .then((cams) => {
        entry.cameraListCache = cams
        entry.cameraListFetchedAt = Date.now()
        entry.lastFetchError = null
        return cams
      })
      .catch((err: unknown) => {
        const classified = classifyCloudError(err)
        entry.lastFetchError = classified
        this.#deps.logger.error('Wyze getCameraList failed', {
          meta: { integrationId, kind: classified.kind, error: classified.message },
        })
        return entry.cameraListCache
      })
      .finally(() => {
        entry.cameraListInFlight = null
      })
    entry.cameraListInFlight = run
    return run
  }
}
