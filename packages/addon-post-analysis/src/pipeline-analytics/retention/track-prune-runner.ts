/**
 * The track cascade's retention entry points — the time prune, the operator
 * clean slate and the disk-wins reconcile — moved out of
 * `pipeline-analytics/index.ts` verbatim (Plan B, extraction 1).
 */
import type { AddonContext, EventOwnerType, TrackCascadeCounts } from '@camstack/types'
import type { LocationAwareMediaBlobStorage } from '../location-aware-media-storage.js'
import {
  EMPTY_CASCADE_TALLY,
  mergeCascadeTallies,
  runTrackCascadeBatch,
  type TrackCascadeBatchDeps,
} from '../pipeline/delete-track-cascade.js'
import type { PackageBackgroundRegistry } from '../pipeline/package/package-background.js'
import type { PhantomCellRegistry } from '../pipeline/stationary/phantom-cells.js'
import type { StationaryEvidenceLedger } from '../pipeline/stationary/stationary-evidence-ledger.js'
import type { StationaryObjectRegistry } from '../pipeline/stationary/stationary-registry.js'
import type { EventStore } from '../store/event-store.js'
import { type MediaStore, mediaRowLocation } from '../store/media-store.js'
import type { TrackStore } from '../store/track-store.js'
import { reconcileDeviceFromDisk } from './disk-reconcile.js'
import { drainTracksBefore } from './track-drain.js'

/** `pruneTracksBefore`'s input: one device, everything last seen before the cutoff. */
export interface PruneTracksBeforeInput {
  readonly deviceId: number
  readonly cutoffMs: number
}

/** The parts of the addon's cascade registry the prune drains through. */
export interface PruneCascadeHandle
  extends Pick<TrackCascadeBatchDeps, 'registry' | 'expandLeafIdsGrouped'> {
  readonly trackStore: TrackStore
}

/** `deleteTracks`' answer, as far as the reconcile reads it. */
export interface DeletedTracksCount {
  readonly deleted: number
}

/** What the prune reads from the addon. Getters, because the stores are opened
 *  in `onInitialize`, after this runner is constructed. */
export interface TrackPruneRunnerDeps {
  /** The addon context — throws outside the initialized window. */
  readonly ctx: () => AddonContext
  readonly shuttingDown: () => boolean
  readonly trackStore: () => TrackStore | null
  readonly eventStore: () => EventStore | null
  readonly mediaStore: () => MediaStore | null
  readonly mediaLocationStorage: () => LocationAwareMediaBlobStorage | null
  readonly stationaryRegistry: () => StationaryObjectRegistry | null
  readonly phantomCells: () => PhantomCellRegistry | null
  readonly stationaryEvidence: () => StationaryEvidenceLedger | null
  readonly packageBackground: () => PackageBackgroundRegistry | null
  readonly buildTrackCascadeRegistry: () => PruneCascadeHandle | null
  readonly clearLiveTrackState: (deviceId: number, trackId: string) => void
  readonly logExpandBatchFailure: (
    deviceId: number,
    failedIds: readonly string[],
    err: unknown,
  ) => void
  readonly deleteTracks: (input: {
    deviceId: number
    trackIds: readonly string[]
  }) => Promise<DeletedTracksCount>
}

export class TrackPruneRunner {
  constructor(private readonly deps: TrackPruneRunnerDeps) {}

  private get ctx(): AddonContext {
    return this.deps.ctx()
  }

  private get shuttingDown(): boolean {
    return this.deps.shuttingDown()
  }

  private get trackStore(): TrackStore | null {
    return this.deps.trackStore()
  }

  private get eventStore(): EventStore | null {
    return this.deps.eventStore()
  }

  private get mediaStore(): MediaStore | null {
    return this.deps.mediaStore()
  }

  private get mediaLocationStorage(): LocationAwareMediaBlobStorage | null {
    return this.deps.mediaLocationStorage()
  }

  private get stationaryRegistry(): StationaryObjectRegistry | null {
    return this.deps.stationaryRegistry()
  }

  private get phantomCells(): PhantomCellRegistry | null {
    return this.deps.phantomCells()
  }

  private get stationaryEvidence(): StationaryEvidenceLedger | null {
    return this.deps.stationaryEvidence()
  }

  private get packageBackground(): PackageBackgroundRegistry | null {
    return this.deps.packageBackground()
  }

  private buildTrackCascadeRegistry(): PruneCascadeHandle | null {
    return this.deps.buildTrackCascadeRegistry()
  }

  private clearLiveTrackState(deviceId: number, trackId: string): void {
    this.deps.clearLiveTrackState(deviceId, trackId)
  }

  private logExpandBatchFailure(
    deviceId: number,
    failedIds: readonly string[],
    err: unknown,
  ): void {
    this.deps.logExpandBatchFailure(deviceId, failedIds, err)
  }

  private deleteTracks(input: {
    deviceId: number
    trackIds: readonly string[]
  }): Promise<DeletedTracksCount> {
    return this.deps.deleteTracks(input)
  }

  /** Bytes released by the most recent {@link pruneTracksBefore} — read by the
   *  retention pass for the ops-log row. */
  get lastPruneBytes(): number {
    return this.lastPruneBytesValue
  }

  /**
   * Track-centric time-based retention (design §5.1). Drains every persisted
   * track for the device whose `lastSeen < cutoffMs`, page by page, through the
   * widened cascade — enrolled faces/plates + identity media are exempt (design
   * §4).
   *
   * **Every family count here is REAL.** It used to return `tracks` and a
   * literal 0 for every leaf, because `TrackScopedStore.deleteByTracks` returned
   * `void` — so `bytesReclaimed: 0` went onto all 3,732 ops-log rows this addon
   * had ever written and 18.9 GB of leaked media read as "nothing to reclaim"
   * (D161). The bytes ride {@link lastPruneBytes} rather than
   * `TrackCascadeCounts`, which is a cap output shape.
   */
  async pruneTracksBefore(input: {
    deviceId: number
    cutoffMs: number
  }): Promise<TrackCascadeCounts> {
    const empty: TrackCascadeCounts = {
      tracks: 0,
      events: 0,
      media: 0,
      faces: 0,
      plates: 0,
      embeddings: 0,
    }
    this.lastPruneBytesValue = 0
    const cascade = this.buildTrackCascadeRegistry()
    if (!cascade) return empty
    let tally = EMPTY_CASCADE_TALLY
    // The drain loop lives in `retention/track-drain.ts` — PIN-TOLERANT, and
    // extracted so its termination argument is tested rather than asserted in a
    // comment. It steps OVER a row the cascade will not delete instead of
    // stopping the sweep for the whole device (D59's blocker, D61's fix).
    const { deleted: totalDeleted, skipped } = await drainTracksBefore({
      stopped: () => this.shuttingDown,
      listIdsBefore: (offset, limit) =>
        cascade.trackStore.listIdsBefore(input.deviceId, input.cutoffMs, limit, offset),
      cascade: async (ids) => {
        const result = await runTrackCascadeBatch(
          {
            registry: cascade.registry,
            trackStore: cascade.trackStore,
            deviceId: input.deviceId,
            onTrackCleanup: (deviceId, trackId) => this.clearLiveTrackState(deviceId, trackId),
            // D683 (review H4/N6): a late fusion's straggler rows leave with
            // the survivor it named, not only with the survivor's own id —
            // grouped per track across the drain page.
            ...(cascade.expandLeafIdsGrouped !== undefined
              ? { expandLeafIdsGrouped: cascade.expandLeafIdsGrouped }
              : {}),
            onExpandBatchFailure: (failedIds, err) =>
              this.logExpandBatchFailure(input.deviceId, failedIds, err),
            onFailure: (trackId, err) => {
              this.ctx.logger.debug('pruneTracksBefore track failed', {
                tags: { deviceId: input.deviceId },
                meta: { trackId, error: String(err) },
              })
            },
          },
          ids,
        )
        tally = mergeCascadeTallies(tally, result.tally)
        return { deleted: result.deleted }
      },
    })
    if (skipped > 0) {
      // A silently skipped row reads as "there was nothing to do". There was.
      this.ctx.logger.warn('analytics track retention skipped undeletable rows', {
        tags: { deviceId: input.deviceId },
        meta: {
          deviceId: input.deviceId,
          cutoffMs: input.cutoffMs,
          skipped,
          pruned: totalDeleted,
        },
      })
    }
    this.lastPruneBytesValue = tally.bytesReclaimed
    if (totalDeleted > 0) {
      // The per-device SUMMARY of one sweep. Every family, and the bytes — a
      // line saying only "N tracks" cannot distinguish a cascade that reached
      // its leaves from one that did not, which is the exact question 18.9 GB
      // of orphans went unanswered on for 16 days (D161).
      this.ctx.logger.info('analytics track retention prune', {
        tags: { deviceId: input.deviceId },
        meta: {
          deviceId: input.deviceId,
          cutoffMs: input.cutoffMs,
          tracks: totalDeleted,
          events: tally.events,
          media: tally.media,
          faces: tally.faces,
          plates: tally.plates,
          embeddings: tally.embeddings,
          // Bookkeeping, not operator-facing media/recognition data — never on
          // `TrackCascadeCounts` (the cap output shape), but real rows still
          // deserve a count on the one line that already reports every family.
          aliases: tally.aliases,
          bytesReclaimed: tally.bytesReclaimed,
        },
      })
    }
    return {
      ...empty,
      tracks: totalDeleted,
      events: tally.events,
      media: tally.media,
      faces: tally.faces,
      plates: tally.plates,
      embeddings: tally.embeddings,
    }
  }

  /**
   * Bytes released by the most recent {@link pruneTracksBefore}.
   *
   * A field rather than a return value because `TrackCascadeCounts` is a cap
   * OUTPUT shape and widening it is a codegen change; the ops-log row already
   * has a `bytesReclaimed` column and this is what fills it. Reset to 0 at the
   * top of every prune, so a stale value can never be reported as a fresh one.
   */
  private lastPruneBytesValue = 0

  /**
   * Operator "clean slate" for a device (design §5.3): prune EVERY persisted
   * track via the same cascade as `pruneTracksBefore` with `cutoffMs = now`.
   * Enrolled gallery + identity media are exempt.
   */
  async wipeAllAnalytics(input: { deviceId: number }): Promise<TrackCascadeCounts> {
    // Clean slate also drops the device's parked-object registry entries.
    await this.stationaryRegistry?.clearDevice(input.deviceId)
    await this.phantomCells?.clearDevice(input.deviceId)
    await this.stationaryEvidence?.clearDevice(input.deviceId)
    await this.packageBackground?.clearDevice(input.deviceId)
    return this.pruneTracksBefore({
      deviceId: input.deviceId,
      cutoffMs: Date.now(),
    })
  }

  /**
   * Disk-wins reconcile: drop media rows whose blobs are gone, then cascade
   * tracks (including favourited/staging) that have no remaining files, then
   * drop trackless motion/audio events with no remaining file (including
   * snapshot-less rows). Enrolled identity/vehicle/scene media is never probed.
   */
  async reconcileFromDisk(input: { deviceId: number }): Promise<{
    mediaDropped: number
    tracks: number
    events: number
  }> {
    const empty = { mediaDropped: 0, tracks: 0, events: 0 }
    const mediaStore = this.mediaStore
    const trackStore = this.trackStore
    const eventStore = this.eventStore
    const storage = this.mediaLocationStorage
    if (!mediaStore || !trackStore || !eventStore || !storage) return empty

    const PAGE = 500
    const counts = await reconcileDeviceFromDisk(
      {
        pageMedia: async (deviceId, offset, limit) => {
          const rows = await mediaStore.pageForDevice(deviceId, offset, limit)
          return rows.map((row) => ({
            mediaId: row.mediaId,
            ownerKind: String(row.data['ownerKind'] ?? ''),
            ownerId: String(row.data['ownerId'] ?? ''),
            path: String(row.data['path'] ?? ''),
            location: mediaRowLocation(row.data),
          }))
        },
        blobExists: async (location, relativePath) => {
          if (storage.exists) return storage.exists({ location, relativePath })
          try {
            await storage.read({ location, relativePath })
            return true
          } catch {
            return false
          }
        },
        deleteMediaId: (key) => mediaStore.deleteById(key),
        listTrackIds: async (deviceId) => {
          const ids: string[] = []
          let offset = 0
          for (;;) {
            const page = await trackStore.listIdsForDevice(deviceId, PAGE, offset)
            if (page.length === 0) break
            ids.push(...page)
            offset += page.length
            if (page.length < PAGE) break
          }
          return ids
        },
        listTracklessEventIds: (deviceId) => eventStore.listTracklessIds(deviceId),
        deleteTracks: async (trackIds) => {
          const result = await this.deleteTracks({
            deviceId: input.deviceId,
            trackIds,
          })
          return { deleted: result.deleted }
        },
        // Per TABLE: post-D474 an id names a row in one table only, and the
        // old id-only delete removed the same number from motion AND audio.
        deleteEvents: async (refs) => {
          const byTable = new Map<EventOwnerType, string[]>()
          for (const ref of refs) {
            const ids = byTable.get(ref.table) ?? []
            ids.push(ref.id)
            byTable.set(ref.table, ids)
          }
          for (const [table, ids] of byTable) await eventStore.deleteByIdsIn(table, ids)
        },
      },
      input.deviceId,
    )
    this.ctx.logger.info('analytics disk reconcile', {
      tags: { deviceId: input.deviceId },
      meta: { deviceId: input.deviceId, ...counts },
    })
    return counts
  }
}
