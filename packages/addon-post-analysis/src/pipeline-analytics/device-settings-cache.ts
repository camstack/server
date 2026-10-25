/**
 * S6 (refactor spec 2026-07-22-post-analysis-maintainability-refactor):
 * ONE generic per-device settings TTL cache replacing the nine copy-pasted
 * `resolveDeviceXSettings` TTL Maps on the pipeline-analytics addon class.
 *
 * Shape: the addon registers one typed cache per settings KIND (audio,
 * tracking, media, …) on a shared `DeviceSettingsCacheHub`; each registration
 * fixes the kind's key + TTL and returns a typed handle (`DeviceTtlCache<T>` /
 * `GlobalTtlCache<T>`), so reads stay fully typed with NO casts. The hub owns
 * the cross-kind invalidation surface: `clearDevice(deviceId)` collapses the
 * old hand-listed per-map delete litanies to one call, `clearAll()` the
 * dispose-time litany.
 *
 * Behavior parity with the legacy per-map code (A2 — NO behavior change):
 * - NO single-flight: concurrent cold reads each run the loader and the last
 *   write wins — exactly what the nine hand-rolled resolvers did.
 * - `expiresAt` is stamped from the time the lookup STARTED (pre-loader), not
 *   from when the loader resolved — matching the legacy `now + TTL` capture.
 * - `peek` returns a present-but-EXPIRED value: the legacy synchronous
 *   stationary read (`stationarySettingsFromCache`) did not check `expiresAt`.
 * - Expired entries are replaced on the next `get`, never proactively swept —
 *   entries linger until the device is cleared, as before.
 */

/** Injectable clock (tests); defaults to `Date.now`. */
type NowFn = () => number

interface CacheEntry<T> {
  readonly value: T
  readonly expiresAt: number
}

/** Loader for one device's settings of a given kind (store read + resolve). */
type DeviceSettingsLoader<T> = (deviceId: number) => Promise<T>

/** Loader for a single global (non-device-scoped) cached value. */
type GlobalSettingsLoader<T> = () => Promise<T>

/** What the hub needs from every registered per-device cache to invalidate. */
interface ClearablePerDeviceCache {
  delete(deviceId: number): void
  clear(): void
}

/** What the hub needs from every registered global cache to invalidate. */
interface ClearableGlobalCache {
  clear(): void
}

/**
 * TTL cache for ONE settings kind, keyed by deviceId. Obtain instances via
 * `DeviceSettingsCacheHub.registerDeviceCache` so hub-wide invalidation
 * (`clearDevice` / `clearAll`) reaches every kind.
 */
export class DeviceTtlCache<T> implements ClearablePerDeviceCache {
  private readonly entries = new Map<number, CacheEntry<T>>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: NowFn,
  ) {}

  /** Fresh-or-load read. No single-flight (legacy parity — see module doc). */
  async get(deviceId: number, loader: DeviceSettingsLoader<T>): Promise<T> {
    const at = this.now()
    const cached = this.entries.get(deviceId)
    if (cached && at < cached.expiresAt) return cached.value
    const value = await loader(deviceId)
    this.entries.set(deviceId, { value, expiresAt: at + this.ttlMs })
    return value
  }

  /**
   * Synchronous read of whatever is cached — INCLUDING an expired entry
   * (legacy parity: the sync stationary read never checked `expiresAt`).
   */
  peek(deviceId: number): T | undefined {
    return this.entries.get(deviceId)?.value
  }

  delete(deviceId: number): void {
    this.entries.delete(deviceId)
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * TTL cache for ONE global (non-device-scoped) settings value. Cleared by
 * `DeviceSettingsCacheHub.clearAll` but deliberately NOT by `clearDevice`
 * (legacy parity: the per-device invalidation litanies never touched it).
 */
export class GlobalTtlCache<T> implements ClearableGlobalCache {
  private entry: CacheEntry<T> | null = null

  constructor(
    private readonly ttlMs: number,
    private readonly now: NowFn,
  ) {}

  /** Fresh-or-load read. No single-flight (legacy parity — see module doc). */
  async get(loader: GlobalSettingsLoader<T>): Promise<T> {
    const at = this.now()
    if (this.entry && at < this.entry.expiresAt) return this.entry.value
    const value = await loader()
    this.entry = { value, expiresAt: at + this.ttlMs }
    return value
  }

  clear(): void {
    this.entry = null
  }
}

/**
 * Registry of every settings cache with the two invalidation entry points.
 * One instance per addon; each settings kind registers exactly once (a
 * duplicate key is a programming error and throws).
 */
export class DeviceSettingsCacheHub {
  private readonly deviceCaches = new Map<string, ClearablePerDeviceCache>()
  private readonly globalCaches = new Map<string, ClearableGlobalCache>()

  constructor(private readonly now: NowFn = () => Date.now()) {}

  /** Create + track the per-device cache for one settings kind. */
  registerDeviceCache<T>(key: string, ttlMs: number): DeviceTtlCache<T> {
    if (this.deviceCaches.has(key)) {
      throw new Error(`DeviceSettingsCacheHub: duplicate device cache key "${key}"`)
    }
    const cache = new DeviceTtlCache<T>(ttlMs, this.now)
    this.deviceCaches.set(key, cache)
    return cache
  }

  /** Create + track a global (non-device-scoped) cache. */
  registerGlobalCache<T>(key: string, ttlMs: number): GlobalTtlCache<T> {
    if (this.globalCaches.has(key)) {
      throw new Error(`DeviceSettingsCacheHub: duplicate global cache key "${key}"`)
    }
    const cache = new GlobalTtlCache<T>(ttlMs, this.now)
    this.globalCaches.set(key, cache)
    return cache
  }

  /** Drop ONE device's entry from every registered per-device cache — the
   *  single-call replacement for the old hand-listed delete litanies. */
  clearDevice(deviceId: number): void {
    for (const cache of this.deviceCaches.values()) cache.delete(deviceId)
  }

  /** Drop everything (addon dispose): all per-device + all global caches. */
  clearAll(): void {
    for (const cache of this.deviceCaches.values()) cache.clear()
    for (const cache of this.globalCaches.values()) cache.clear()
  }
}
