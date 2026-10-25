/**
 * TurnServerCache — shared STUN/TURN credential cache for the WebRTC connect
 * path.
 *
 * ## Why this exists
 *
 * The ICE-server fetch is serialized BEFORE `createOffer` on every connect
 * (`camera-stream-player.tsx` → `getIceServers()`), so its latency lands 1:1
 * in the time-to-first-frame. Production `embed:webrtc-timing` lines measured
 * it at 0.2–3.6 s on a cold page. Two verified defects drove that:
 *
 *  1. **No in-flight coalescing.** The mount-time prefetch and the connect's
 *     own call raced: whichever started second issued a SECOND full
 *     `getTurnServers` round trip instead of awaiting the first.
 *  2. **Per-page cache.** The cache was a `WeakMap` keyed on the page's tRPC
 *     client. The native app loads a fresh embed page per camera open, so the
 *     common remote path started cold every single time.
 *
 * ## Design
 *
 * Three layers, checked in order:
 *  - **memory** (`WeakMap` keyed on the caller's tRPC client — unchanged
 *    semantics: two admin tabs pointed at different hubs never cross-serve),
 *  - **in-flight** (concurrent callers share one promise),
 *  - **storage** (`localStorage` when available) so a fresh page finds warm
 *    credentials. Storage is per-origin, and the page's origin IS the hub, so
 *    cross-hub leakage is structurally impossible.
 *
 * Freshness: entries younger than `freshTtlMs` are served as-is. Entries older
 * than that but younger than `staleCapMs` are served IMMEDIATELY while a
 * background refresh runs (credentials from the hub's providers are valid for
 * hours — e.g. 24 h for the managed-relay provider — so a bounded stale window
 * is safe; an actually-expired relay credential degrades to the public-STUN
 * fallback exactly like an absent one, and the refresh heals the next
 * connect). Beyond `staleCapMs` the fetch is awaited.
 *
 * Failure: a failed fetch serves the stale entry when one exists, else
 * `undefined` (caller falls back to public STUN). Failures are never cached.
 */

/** Narrow storage contract — satisfied by `localStorage`, injectable in tests. */
export interface TurnCacheStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface TurnServerCacheOptions {
  /** Entries younger than this are served without any fetch. */
  readonly freshTtlMs?: number
  /** Entries older than `freshTtlMs` but younger than this are served
   *  immediately while a background refresh runs. */
  readonly staleCapMs?: number
  /** Storage layer. `null` disables persistence (memory-only). When omitted,
   *  `globalThis.localStorage` is used if present. */
  readonly storage?: TurnCacheStorage | null
  readonly now?: () => number
  readonly storageKey?: string
}

interface CacheEntry {
  readonly servers: readonly RTCIceServer[]
  readonly fetchedAt: number
}

/** Short enough that rotated credentials are picked up promptly. */
const DEFAULT_FRESH_TTL_MS = 5 * 60_000
/** Half of the shortest provider credential lifetime in the fleet (24 h). */
const DEFAULT_STALE_CAP_MS = 12 * 60 * 60_000
const DEFAULT_STORAGE_KEY = 'camstack:turn-servers:v1'

function defaultStorage(): TurnCacheStorage | null {
  const g = globalThis as { localStorage?: TurnCacheStorage }
  try {
    return g.localStorage ?? null
  } catch {
    // Accessing localStorage itself can throw (sandboxed iframe).
    return null
  }
}

/** Type guard for a persisted entry — storage content is external data. */
function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { servers?: unknown; fetchedAt?: unknown }
  if (typeof v.fetchedAt !== 'number' || !Array.isArray(v.servers)) return false
  return v.servers.every((s: unknown) => {
    if (typeof s !== 'object' || s === null) return false
    const srv = s as { urls?: unknown; username?: unknown; credential?: unknown }
    const urlsOk =
      typeof srv.urls === 'string' ||
      (Array.isArray(srv.urls) && srv.urls.every((u: unknown) => typeof u === 'string'))
    if (!urlsOk) return false
    if (srv.username !== undefined && typeof srv.username !== 'string') return false
    if (srv.credential !== undefined && typeof srv.credential !== 'string') return false
    return true
  })
}

export class TurnServerCache {
  private readonly freshTtlMs: number
  private readonly staleCapMs: number
  private readonly storage: TurnCacheStorage | null
  private readonly now: () => number
  private readonly storageKey: string

  /** Keyed on the caller's tRPC client object (stable per connected system). */
  private readonly memory = new WeakMap<object, CacheEntry>()
  /** In-flight fetch per key — concurrent callers share one round trip. */
  private readonly inflight = new WeakMap<object, Promise<readonly RTCIceServer[] | undefined>>()

  constructor(options: TurnServerCacheOptions = {}) {
    this.freshTtlMs = options.freshTtlMs ?? DEFAULT_FRESH_TTL_MS
    this.staleCapMs = options.staleCapMs ?? DEFAULT_STALE_CAP_MS
    this.storage = 'storage' in options ? (options.storage ?? null) : defaultStorage()
    this.now = options.now ?? (() => Date.now())
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY
  }

  /**
   * Resolve the ICE servers for `key`, fetching via `fetch` only when no
   * fresh-enough entry exists. Never rejects: a failed fetch resolves to the
   * stale entry when one exists, else `undefined`.
   */
  async getOrFetch(
    key: object,
    fetch: () => Promise<readonly RTCIceServer[]>,
  ): Promise<readonly RTCIceServer[] | undefined> {
    const at = this.now()
    const entry = this.memory.get(key) ?? this.readStorage()
    if (entry) {
      const age = at - entry.fetchedAt
      if (age < this.freshTtlMs) return entry.servers
      if (age < this.staleCapMs) {
        // Stale-while-revalidate: serve immediately, refresh in background.
        void this.startFetch(key, fetch, entry)
        return entry.servers
      }
    }
    return this.startFetch(key, fetch, entry)
  }

  private startFetch(
    key: object,
    fetch: () => Promise<readonly RTCIceServer[]>,
    stale: CacheEntry | undefined,
  ): Promise<readonly RTCIceServer[] | undefined> {
    const pending = this.inflight.get(key)
    if (pending) return pending
    const run = (async (): Promise<readonly RTCIceServer[] | undefined> => {
      try {
        const servers = await fetch()
        // An empty list means "no TURN provider configured" — usable as a
        // result, but never persisted: a later page must not read [] as a
        // warm credential set and skip its own fetch.
        if (servers.length > 0) {
          const entry: CacheEntry = { servers, fetchedAt: this.now() }
          this.memory.set(key, entry)
          this.writeStorage(entry)
        }
        return servers
      } catch {
        // Serve stale over none: an expired relay credential degrades to the
        // public-STUN fallback, same as returning undefined would.
        return stale?.servers
      }
    })().finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, run)
    return run
  }

  private readStorage(): CacheEntry | undefined {
    if (!this.storage) return undefined
    try {
      const raw = this.storage.getItem(this.storageKey)
      if (raw === null) return undefined
      const parsed: unknown = JSON.parse(raw)
      return isCacheEntry(parsed) ? parsed : undefined
    } catch {
      // Corrupt JSON or a storage that throws (private mode) — cache miss.
      return undefined
    }
  }

  private writeStorage(entry: CacheEntry): void {
    if (!this.storage) return
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(entry))
    } catch {
      // Quota / private-mode write failure is non-fatal — memory layer holds.
    }
  }
}
