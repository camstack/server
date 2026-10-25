import { createHash } from 'node:crypto'
import type { AutoDetectResult } from '@apocaliss92/nodelink-js'

/**
 * Short-lived cache that lets `testCreationField` and `onCreateDevice`
 * share a single `autoDetectDeviceType()` call (and the live API
 * instance it returns) — so the operator's `Test` click and the
 * subsequent `Save` don't each pay a full Baichuan login.
 *
 * Key derivation hashes the password (sha256, hex) so the cache key
 * never carries cleartext credentials. UID is part of the key when
 * present; transport mode is too, because changing the mode invalidates
 * the cached api (a TCP-only api can't service a UDP-flagged save).
 *
 * Entries expire after `DEFAULT_TTL_MS` (60s) — long enough for a human
 * to click Test → Save, short enough that stale device-type information
 * never leaks across firmware upgrades or network changes.
 */

export interface AutodetectCacheEntry {
  readonly result: AutoDetectResult
  readonly expiresAt: number
}

interface AutodetectCacheOptions {
  /** Time-to-live in ms. Default 60_000. */
  readonly ttlMs?: number
  /** Override the wall clock (testing). */
  readonly now?: () => number
}

const DEFAULT_TTL_MS = 60_000

export class AutodetectCache {
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly entries: Map<string, AutodetectCacheEntry> = new Map()

  constructor(options: AutodetectCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? Date.now
  }

  /**
   * Build a cache key from the connection parameters. The password is
   * sha256-hashed to keep the key index-safe and to ensure the
   * cleartext value never lives in the Map. UID and transport are
   * included so two creation attempts with different modes don't share
   * the same api instance.
   */
  static keyFor(input: {
    readonly host: string
    readonly username: string
    readonly password: string
    readonly uid?: string
    readonly transport: 'auto' | 'tcp' | 'udp'
  }): string {
    const passHash = createHash('sha256').update(input.password).digest('hex').slice(0, 16)
    return [
      input.host.trim().toLowerCase(),
      input.username,
      passHash,
      input.uid?.trim() ?? '',
      input.transport,
    ].join(':')
  }

  /**
   * Return the cached entry if it has not expired yet. Expired entries
   * are evicted on lookup so a stale `api` reference doesn't survive
   * past the TTL.
   */
  get(key: string): AutodetectCacheEntry | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      void this.disposeApi(entry.result)
      return null
    }
    return entry
  }

  /**
   * Store a new entry. Replaces (and disposes) any prior entry for the
   * same key so we never leak Baichuan sockets when the user clicks
   * Test twice in a row with slightly different inputs.
   */
  set(key: string, result: AutoDetectResult): void {
    const prior = this.entries.get(key)
    if (prior) {
      void this.disposeApi(prior.result)
    }
    this.entries.set(key, {
      result,
      expiresAt: this.now() + this.ttlMs,
    })
  }

  /**
   * Take the cached entry — removes it from the cache without
   * disposing. Used by `onCreateDevice` when it wants to keep the api
   * alive for the new device.
   */
  take(key: string): AutoDetectResult | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    this.entries.delete(key)
    if (entry.expiresAt <= this.now()) {
      void this.disposeApi(entry.result)
      return null
    }
    return entry.result
  }

  /** Drop everything and dispose every cached api. */
  async dispose(): Promise<void> {
    const all = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(all.map((e) => this.disposeApi(e.result)))
  }

  /** Number of live entries (testing). */
  get size(): number {
    return this.entries.size
  }

  private async disposeApi(result: AutoDetectResult): Promise<void> {
    try {
      await result.api.close({ reason: 'autodetect-cache-evict' })
    } catch {
      /* ignore — disposal is best-effort */
    }
  }
}
