/**
 * The addon-level store and per-device blob RAW reads that back every
 * per-device settings kind, kept fresh OFF each kind's own TTL cache.
 *
 * ## The read this replaces
 *
 * `readDeviceSettings` is the S6 shared cold-miss loader for EVERY per-device
 * settings kind (audio, detection-sensitivity, tracking, confirmation-gate,
 * face, media, stationary, package-drop — eight so far). Each kind owns its
 * own `DeviceTtlCache` (`device-settings-cache.ts`) with its own 5 s clock,
 * and on a miss it called `resolveGlobalStore()` (the addon's ONE
 * `addon_settings` row) and `readDeviceBlob()` (the addon's ONE per-device
 * row) directly — so eight caches expiring within the same window each paid
 * for the SAME two reads independently. Measured on the live hub
 * 2026-08-26: `get pipeline-analytics:addon-settings`, 547–694 calls/min, one
 * row every time; `get pipeline-analytics:addon-devices` (the `readDeviceBlob`
 * chokepoint), ~700/min, 68% finding nothing.
 *
 * ## Why this is not "a cache in the consumer" (D224)
 *
 * This addon OWNS both rows. The only writers of the addon store are
 * `updateGlobalSettings` (via `onConfigChanged`, gated to the LOCAL node's own
 * write — the same gate `resolveGlobalStore`'s per-node projection already
 * relies on) and the addon's own retired-setting purges; the only writers of
 * a device's row are `applyDeviceSettingsPatch` and the same purges. Every one
 * of them calls {@link RawGlobalStoreMirror.invalidate} /
 * {@link RawDeviceBlobMirror.invalidate} in the SAME process as the write, so
 * an operator's own change is never served from a stale mirror — the window
 * below governs only "nobody in this process wrote it".
 *
 * ## The window, declared
 *
 * {@link RAW_SETTINGS_STALE_MS} reuses the per-kind caches' own
 * `SETTINGS_CACHE_TTL_MS` (5 s): this mirror does not change how stale an
 * operator's change can read, it removes the 8x duplicate read for the SAME
 * staleness bound. A stale entry is SERVED and revalidated behind the caller,
 * never awaited — `readDeviceSettings` runs on the ~30 Hz frame path, and a
 * frame that waits on the settings store is a frame the pipeline dropped.
 */

type NowFn = () => number

interface MirrorEntry<T> {
  readonly value: T
  fetchedAt: number
}

/** How long a mirrored entry is served before a refresh is started behind the
 *  next reader. See the module doc for why this matches the per-kind caches'
 *  own window rather than introducing a second staleness bound. */
export const RAW_SETTINGS_STALE_MS = 5_000

/**
 * How long a FAILED refresh is not retried.
 *
 * A refresh that throws leaves `fetchedAt` where it was, so without a
 * cooldown every subsequent reader would start another attempt — a broken
 * settings store would be hammered at frame rate by the very mechanism built
 * to stop that.
 */
export const RAW_SETTINGS_MISS_COOLDOWN_MS = 5_000

/**
 * The addon's per-device raw blob (`pipeline-analytics:addon-devices`), kept
 * fresh OFF every per-kind settings cache's hot path.
 *
 * `resolve` is COLD-awaiting and single-flight: a burst of settings kinds
 * (or frames) missing on the same device in the same tick costs ONE read,
 * not one per caller — the exact failure this class exists to remove.
 */
export class RawDeviceBlobMirror {
  private readonly entries = new Map<number, MirrorEntry<Record<string, unknown>>>()
  private readonly inFlight = new Map<number, Promise<Record<string, unknown>>>()
  private readonly now: NowFn

  constructor(
    private readonly deps: {
      /** The addon's own per-device blob read (`readDeviceBlob`). */
      read(deviceId: number): Promise<Record<string, unknown>>
      now?: NowFn
      /** A refresh that did not land. Never silent: a branch that keeps
       *  serving an old blob has to say so. */
      onRefreshFailed?(deviceId: number, err: unknown): void
    },
    private readonly staleMs: number = RAW_SETTINGS_STALE_MS,
    private readonly missCooldownMs: number = RAW_SETTINGS_MISS_COOLDOWN_MS,
  ) {
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * The device's raw stored blob.
   *
   * COLD awaits — the first settings kind to touch a device has to get the
   * real answer. WARM returns immediately, stale or not, and starts the
   * refresh behind the caller.
   */
  async resolve(deviceId: number): Promise<Record<string, unknown>> {
    const entry = this.entries.get(deviceId)
    if (entry === undefined) return this.load(deviceId)
    if (this.now() - entry.fetchedAt >= this.staleMs) void this.load(deviceId)
    return entry.value
  }

  /** Drop a device's entry. Called by every in-process writer of this
   *  device's row, so an operator's own change is never served stale. */
  invalidate(deviceId: number): void {
    this.entries.delete(deviceId)
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  private async load(deviceId: number): Promise<Record<string, unknown>> {
    const pending = this.inFlight.get(deviceId)
    if (pending !== undefined) return pending
    const run = this.deps
      .read(deviceId)
      .then((value) => {
        this.entries.set(deviceId, { value, fetchedAt: this.now() })
        return value
      })
      .catch((err: unknown) => {
        this.deps.onRefreshFailed?.(deviceId, err)
        const existing = this.entries.get(deviceId)
        if (existing !== undefined) {
          // Hold the old value; push `fetchedAt` forward by the cooldown
          // rather than by the full window, so the NEXT caller doesn't retry.
          existing.fetchedAt = this.now() - this.staleMs + this.missCooldownMs
          return existing.value
        }
        // Cold and failed: answer empty for this call, let the next one try
        // again. Caching the empty answer would turn one hiccup into a
        // window of ignored device overrides.
        return {}
      })
      .finally(() => {
        this.inFlight.delete(deviceId)
      })
    this.inFlight.set(deviceId, run)
    return run
  }
}

/**
 * The addon's ONE `addon_settings` row (`pipeline-analytics:addon-settings`),
 * kept fresh OFF every per-kind settings cache's hot path. Same shape as
 * {@link RawDeviceBlobMirror}, singleton rather than keyed — there is exactly
 * one addon store per process.
 */
export class RawGlobalStoreMirror {
  private entry: MirrorEntry<Record<string, unknown>> | null = null
  private inFlight: Promise<Record<string, unknown>> | null = null
  private readonly now: NowFn

  constructor(
    private readonly deps: {
      /** The addon's own global store read (`resolveGlobalStore`). */
      read(): Promise<Record<string, unknown>>
      now?: NowFn
      onRefreshFailed?(err: unknown): void
    },
    private readonly staleMs: number = RAW_SETTINGS_STALE_MS,
    private readonly missCooldownMs: number = RAW_SETTINGS_MISS_COOLDOWN_MS,
  ) {
    this.now = deps.now ?? (() => Date.now())
  }

  async resolve(): Promise<Record<string, unknown>> {
    const entry = this.entry
    if (entry === null) return this.load()
    if (this.now() - entry.fetchedAt >= this.staleMs) void this.load()
    return entry.value
  }

  /** Drop the mirrored store. Called by every in-process global-settings
   *  writer (`onConfigChanged`), so an operator's own change is never served
   *  stale. */
  invalidate(): void {
    this.entry = null
  }

  private async load(): Promise<Record<string, unknown>> {
    if (this.inFlight !== null) return this.inFlight
    const run = this.deps
      .read()
      .then((value) => {
        this.entry = { value, fetchedAt: this.now() }
        return value
      })
      .catch((err: unknown) => {
        this.deps.onRefreshFailed?.(err)
        const existing = this.entry
        if (existing !== null) {
          this.entry = {
            value: existing.value,
            fetchedAt: this.now() - this.staleMs + this.missCooldownMs,
          }
          return existing.value
        }
        return {}
      })
      .finally(() => {
        this.inFlight = null
      })
    this.inFlight = run
    return run
  }
}
