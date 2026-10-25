import type { IScopedLogger, IStorageEvictableProvider } from '@camstack/types'
import type { DrainProgress, DrainState } from './drain-ratchet.js'
import { drainProgressOf, stepDrain } from './drain-ratchet.js'

/**
 * One draining location and the ACTIVE locations of its class the drain is
 * paced against (D386). Supplied by the orchestrator, which is the only thing
 * that knows a location's mode.
 */
export interface DrainPlanEntry {
  readonly locationId: string
  /** Locations of the SAME class whose growth the drain is matched to. Empty
   *  means the pace is unmeasurable and the cap stands still. */
  readonly activePeerLocationIds: readonly string[]
}

/**
 * Durable home for the ratchet state. It MUST survive a process restart: a cap
 * recomputed from today's usage starts again at the top and silently undoes
 * every byte of progress.
 */
export interface DrainStateStore {
  load(): Promise<readonly DrainState[]>
  save(state: DrainState): Promise<void>
  clear(locationId: string): Promise<void>
}

/**
 * StoragePressureManager — core-owned TRIGGER for disk-space relief.
 *
 * Monitors free space per managed location and, when a location drops below its
 * `minFreePercent`, asks each registered `storage-evictable` provider to free a
 * proportional share of the byte deficit. The PROVIDER decides what to delete
 * and does the deletion — core never deletes data it doesn't understand. This
 * makes disk-pressure one cross-consumer concern instead of per-addon guards.
 *
 * Convergence: a bounded round loop re-reads free% after each fan-out and stops
 * when the location recovers, when nothing is evictable, or when a round makes
 * no progress (every provider exhausted). Lossless feedback (`reclaimedBytes`)
 * drives the stop condition; the addon re-runs `sweep()` on a timer so a partial
 * relief finishes on the next tick.
 */
export interface PressureManagerDeps {
  readonly logger: IScopedLogger
  /** Free capacity (%) on the location's volume. */
  readonly getFreePercent: (locationId: string) => Promise<number>
  /** Total bytes on the location's volume (to turn a deficit % into a byte target). */
  readonly getVolumeTotalBytes: (locationId: string) => Promise<number>
  /** Registered `storage-evictable` providers (cross-process proxies). */
  readonly getEvictableProviders: () => readonly IStorageEvictableProvider[]
  /** locationId → minFreePercent threshold; entries with `<= 0` have the guard off. */
  readonly getLocationThresholds: () => Promise<ReadonlyMap<string, number>>
  /** locationId → hard cap on EVICTABLE bytes (`config.maxUsedGb`, operator's
   *  "recordings may use at most N GB total"). Optional — absent = no caps. */
  readonly getLocationMaxUsedBytes?: () => Promise<ReadonlyMap<string, number>>
  /** Max relief rounds per location per sweep (backstop, default 8). */
  readonly maxRounds?: number
  /** Extra headroom % freed beyond the threshold to avoid re-breaching immediately (default 1). */
  readonly hysteresisPercent?: number
  /**
   * Optional: map a locationId to a stable key identifying its PHYSICAL storage
   * device — the `realpath` of the location's `basePath`, so aliases (symlinks /
   * bind-mounts) and same-root managed locations (`recordings:default` +
   * `recordingsLow:default`, both at `/recordings`) share one key.
   *
   * Powers an in-sweep dedup: once a physical device has actually been RELIEVED
   * this sweep, other locations resolving to the SAME device are skipped for the
   * rest of the tick. This closes a bounded OVER-eviction window — after the
   * first alias frees the shared disk, a second alias re-reading not-yet-settled
   * `statfs` free% (lazy fs accounting, open fds) could see it still breached and
   * evict the oldest footage a second time. A fresh sweep on the next timer tick
   * re-checks the settled free% and finishes any genuinely-residual pressure, so
   * skipping can only ever DEFER relief (self-correcting), never over-delete.
   *
   * Omitted, or returning `null`, → no dedup (each location relieved
   * independently), preserving prior single-disk behaviour.
   */
  readonly getLocationDeviceKey?: (locationId: string) => Promise<string | null>
  /** Locations in `drain` mode, each with the active peers of its class.
   *  Absent → no drain (the behaviour before D386). */
  readonly getDrainPlan?: () => Promise<readonly DrainPlanEntry[]>
  /** Where the ratchet state lives across restarts. Absent → drain is inert:
   *  without persistence the cap would reset on every boot, which is worse
   *  than not draining. */
  readonly drainState?: DrainStateStore
}

const DEFAULT_MAX_ROUNDS = 8
const DEFAULT_HYSTERESIS_PERCENT = 1

export class StoragePressureManager {
  /** Last sweep's drain progress, by location. Read-only surface for the UI. */
  private drainProgress = new Map<string, DrainProgress>()

  constructor(private readonly deps: PressureManagerDeps) {}

  /** Relieve every managed location currently under its threshold. */
  async sweep(): Promise<void> {
    const thresholds = await this.deps.getLocationThresholds()
    // Physical-device keys already RELIEVED this sweep — a second location on the
    // same disk is skipped to avoid a bounded over-eviction re-run (see
    // `getLocationDeviceKey`). Only actual relief (a breach that evicted) marks a
    // key; a non-breached location leaves the key open so a stricter-threshold
    // sibling on the same disk still gets its chance this tick.
    const relievedDevices = new Set<string>()
    for (const [locationId, threshold] of thresholds) {
      if (threshold <= 0) continue
      const deviceKey = (await this.deps.getLocationDeviceKey?.(locationId)) ?? null
      if (deviceKey !== null && relievedDevices.has(deviceKey)) {
        this.deps.logger.debug(
          'storage pressure: skipping location — physical device already relieved this sweep',
          { meta: { locationId, deviceKey } },
        )
        continue
      }
      try {
        const relieved = await this.relieveLocation(locationId, threshold)
        if (relieved && deviceKey !== null) relievedDevices.add(deviceKey)
      } catch (err) {
        this.deps.logger.warn('storage pressure: relief failed for location', {
          meta: { locationId, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    // Second guard: the per-location TOTAL-usage cap (maxUsedGb). Independent
    // of disk free space — an operator bounding recordings to N GB on a big
    // shared disk needs eviction long before the volume runs low.
    const caps = (await this.deps.getLocationMaxUsedBytes?.()) ?? new Map<string, number>()
    for (const [locationId, maxBytes] of caps) {
      if (relievedDevices.size > 0) {
        const deviceKey = (await this.deps.getLocationDeviceKey?.(locationId)) ?? null
        if (deviceKey !== null && relievedDevices.has(deviceKey)) continue
      }
      try {
        await this.relieveToUsageCap(locationId, maxBytes)
      } catch (err) {
        this.deps.logger.warn('storage pressure: usage-cap relief failed', {
          meta: { locationId, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    await this.sweepDrains()
  }

  /**
   * The drain pass (D386). A `drain` location is excluded from nothing — it is
   * given a monotonically descending effective usage cap and handed to the SAME
   * `relieveToUsageCap` machinery every other cap uses. There is no second
   * eviction path, and no operator-facing rate.
   */
  private async sweepDrains(): Promise<void> {
    const plan = (await this.deps.getDrainPlan?.()) ?? []
    const store = this.deps.drainState
    if (store === undefined) {
      if (plan.length > 0) {
        this.deps.logger.warn(
          'storage drain: locations are draining but no durable state store is wired — ' +
            'the ratchet stays inert rather than restarting from scratch every boot',
          { meta: { locationIds: plan.map((e) => e.locationId) } },
        )
      }
      this.drainProgress = new Map()
      return
    }

    const persisted = new Map((await store.load()).map((state) => [state.locationId, state]))
    const draining = new Set(plan.map((entry) => entry.locationId))
    // A location switched back to `readonly` or `active` stops IMMEDIATELY: its
    // state is dropped, so a later re-drain begins a fresh ratchet rather than
    // resuming a cap the operator has since overruled.
    for (const locationId of persisted.keys()) {
      if (draining.has(locationId)) continue
      await store.clear(locationId)
      this.drainProgress.delete(locationId)
      this.deps.logger.info('storage drain: stopped — location is no longer draining', {
        meta: { locationId },
      })
    }

    const nowMs = Date.now()
    const progress = new Map<string, DrainProgress>()
    for (const entry of plan) {
      try {
        const usedBytes = await this.evictableUsageOf(entry.locationId)
        const peerUsedBytes =
          entry.activePeerLocationIds.length === 0
            ? null
            : await this.evictableUsageOfAll(entry.activePeerLocationIds)
        const step = stepDrain(persisted.get(entry.locationId) ?? null, {
          locationId: entry.locationId,
          usedBytes,
          peerUsedBytes,
          atMs: nowMs,
        })
        await store.save(step.state)
        this.deps.logger.info('storage drain: sweep', {
          meta: {
            locationId: entry.locationId,
            usedBytes,
            peerUsedBytes,
            growthBytes: step.growthBytes,
            capBytes: step.capBytes,
            drained: step.drained,
          },
        })
        if (step.capBytes !== null) await this.relieveToUsageCap(entry.locationId, step.capBytes)
        // Progress is reported AFTER the relief, from a fresh read: a UI that
        // showed the pre-eviction figure would be one sweep behind forever.
        progress.set(
          entry.locationId,
          drainProgressOf(step.state, await this.evictableUsageOf(entry.locationId), nowMs),
        )
      } catch (err) {
        this.deps.logger.warn('storage drain: sweep failed for location', {
          meta: {
            locationId: entry.locationId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
    this.drainProgress = progress
  }

  /** Progress for every draining location, as of the last sweep. The read a UI
   *  asks for — it never triggers work of its own. */
  drainProgressSnapshot(): readonly DrainProgress[] {
    return [...this.drainProgress.values()]
  }

  /** Evictable bytes on one location, summed across every provider. */
  private async evictableUsageOf(locationId: string): Promise<number> {
    const providers = this.deps.getEvictableProviders()
    const usages = await Promise.all(
      providers.map(async (p) => (await p.getEvictableUsage({ locationId })).bytes),
    )
    return usages.reduce((sum, bytes) => sum + bytes, 0)
  }

  /** Evictable bytes across a set of locations. */
  private async evictableUsageOfAll(locationIds: readonly string[]): Promise<number> {
    const each = await Promise.all(locationIds.map((id) => this.evictableUsageOf(id)))
    return each.reduce((sum, bytes) => sum + bytes, 0)
  }

  /** Evict oldest-first until the location's evictable usage fits `maxBytes`. */
  private async relieveToUsageCap(locationId: string, maxBytes: number): Promise<void> {
    const maxRounds = this.deps.maxRounds ?? DEFAULT_MAX_ROUNDS
    for (let round = 0; round < maxRounds; round++) {
      const providers = this.deps.getEvictableProviders()
      const usages = await Promise.all(
        providers.map(async (p) => ({
          p,
          bytes: (await p.getEvictableUsage({ locationId })).bytes,
        })),
      )
      const totalUsed = usages.reduce((s, u) => s + u.bytes, 0)
      const excess = totalUsed - maxBytes
      if (excess <= 0) return
      let reclaimed = 0
      for (const u of usages) {
        if (u.bytes <= 0) continue
        const share = Math.max(1, Math.ceil((excess * u.bytes) / totalUsed))
        const res = await u.p.evict({ locationId, targetBytes: share })
        reclaimed += res.reclaimedBytes
      }
      this.deps.logger.info('storage pressure: usage-cap relief round', {
        meta: { locationId, round, totalUsed, maxBytes, reclaimedBytes: reclaimed },
      })
      if (reclaimed <= 0) return
    }
  }

  /**
   * Relieve one location until it recovers, nothing is evictable, or a round
   * makes no progress. Returns `true` when at least one relief round actually
   * reclaimed bytes (so the caller marks the location's physical device relieved
   * for this sweep — the trigger for the over-eviction dedup: freed bytes mean a
   * sibling alias may re-read a not-yet-settled `statfs`), `false` when nothing
   * was freed (never breached, or breached with no evictable data).
   */
  private async relieveLocation(locationId: string, threshold: number): Promise<boolean> {
    const maxRounds = this.deps.maxRounds ?? DEFAULT_MAX_ROUNDS
    const hysteresis = this.deps.hysteresisPercent ?? DEFAULT_HYSTERESIS_PERCENT
    let reclaimedAny = false

    for (let round = 0; round < maxRounds; round++) {
      const free = await this.deps.getFreePercent(locationId)
      if (free >= threshold) return reclaimedAny // recovered (or never breached)

      const total = await this.deps.getVolumeTotalBytes(locationId)
      const deficitPercent = threshold - free + hysteresis
      const targetBytes = Math.ceil((total * deficitPercent) / 100)
      if (targetBytes <= 0) return reclaimedAny

      const providers = this.deps.getEvictableProviders()
      const usages = await Promise.all(
        providers.map(async (p) => ({
          p,
          bytes: (await p.getEvictableUsage({ locationId })).bytes,
        })),
      )
      const totalEvictable = usages.reduce((s, u) => s + u.bytes, 0)
      if (totalEvictable <= 0) {
        // Breached but no addon owns evictable data here (e.g. data/logs/backups
        // volumes) — the system can't relieve it; an operator must free space.
        // Debug, not info: it would otherwise repeat every sweep per location.
        this.deps.logger.debug('storage pressure: breach but no evictable data on location', {
          meta: { locationId, freePercent: free, threshold },
        })
        return reclaimedAny
      }

      let reclaimed = 0
      for (const u of usages) {
        if (u.bytes <= 0) continue
        // Proportional share of the deficit, by footprint on this location.
        const share = Math.max(1, Math.ceil((targetBytes * u.bytes) / totalEvictable))
        const res = await u.p.evict({ locationId, targetBytes: share })
        reclaimed += res.reclaimedBytes
      }
      if (reclaimed > 0) reclaimedAny = true

      this.deps.logger.info('storage pressure: relief round', {
        meta: {
          locationId,
          round,
          freePercent: free,
          threshold,
          targetBytes,
          reclaimedBytes: reclaimed,
        },
      })

      if (reclaimed <= 0) return reclaimedAny // no progress — every provider exhausted
    }
    return reclaimedAny
  }
}
