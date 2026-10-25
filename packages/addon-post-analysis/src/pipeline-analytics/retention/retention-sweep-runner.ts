/**
 * The periodic retention pass (D61/D62) — moved out of
 * `pipeline-analytics/index.ts` verbatim (Plan B, extraction 1).
 *
 * One age-keyed sweep over TRACKS on one window per device, the trackless
 * roots on the same window, and the face/plate buffer CAPACITY bounds. The
 * track cascade itself is `TrackPruneRunner`; the one-shot retired-settings
 * purges the pass runs first are `RetiredSettingsPurge`.
 */
import type { AddonContext, TrackCascadeCounts } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { deriveSuggestedBufferCap, FACE_DEFAULTS, resolveFaceSettings } from '../face-settings.js'
import { type DeviceRetentionCutoffs, resolveRetentionSettings } from '../retention-policy.js'
import type { EventStore } from '../store/event-store.js'
import type { FaceStore } from '../store/face-store.js'
import type { MediaStore } from '../store/media-store.js'
import type { OpsLogStore } from '../store/ops-log-store.js'
import type { PlateStore } from '../store/plate-store.js'
import type { SensorEventStore } from '../store/sensor-event-store.js'
import type { TrackStore } from '../store/track-store.js'
import { sweepTrackRetention } from '../track-retention-sweep.js'
import { ArchiveFootageFloors } from './archive-footage-floor.js'
import { memoEventDeviceIds, retentionScopeDeviceIds } from './retention-scope.js'
import type { RetiredSettingsPurge } from './retired-settings-purge.js'
import { RetentionSweepSummary } from './sweep-summary.js'
import type { PruneTracksBeforeInput, TrackPruneRunner } from './track-prune-runner.js'
import { sweepTracklessRoots } from './trackless-root-sweep.js'

/** What the retention pass reads from the addon. Getters, because the stores
 *  are opened in `onInitialize`, after this runner is constructed. */
export interface RetentionSweepRunnerDeps {
  /** The addon context — throws outside the initialized window. */
  readonly ctx: () => AddonContext
  readonly shuttingDown: () => boolean
  readonly trackStore: () => TrackStore | null
  readonly eventStore: () => EventStore | null
  readonly mediaStore: () => MediaStore | null
  readonly sensorEventStore: () => SensorEventStore | null
  readonly faceStore: () => FaceStore | null
  readonly plateStore: () => PlateStore | null
  readonly eventsOpsLog: () => OpsLogStore | null
  readonly readDeviceBlob: (deviceId: number) => Promise<Record<string, unknown>>
  readonly resolveGlobalStore: () => Promise<Record<string, unknown>>
  readonly retiredSettings: RetiredSettingsPurge
  readonly trackPrune: TrackPruneRunner
}

export class RetentionSweepRunner {
  constructor(private readonly deps: RetentionSweepRunnerDeps) {}

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

  private get sensorEventStore(): SensorEventStore | null {
    return this.deps.sensorEventStore()
  }

  private get faceStore(): FaceStore | null {
    return this.deps.faceStore()
  }

  private get plateStore(): PlateStore | null {
    return this.deps.plateStore()
  }

  private get eventsOpsLog(): OpsLogStore | null {
    return this.deps.eventsOpsLog()
  }

  private readDeviceBlob(deviceId: number): Promise<Record<string, unknown>> {
    return this.deps.readDeviceBlob(deviceId)
  }

  private resolveGlobalStore(): Promise<Record<string, unknown>> {
    return this.deps.resolveGlobalStore()
  }

  private migrateRetiredRetentionSettings(deviceIds: readonly number[]): Promise<void> {
    return this.deps.retiredSettings.migrateRetiredRetentionSettings(deviceIds)
  }

  private purgeStoredSuggestionThreshold(deviceIds: readonly number[]): Promise<void> {
    return this.deps.retiredSettings.purgeStoredSuggestionThreshold(deviceIds)
  }

  private purgeStoredMinFaceConfidence(deviceIds: readonly number[]): Promise<void> {
    return this.deps.retiredSettings.purgeStoredMinFaceConfidence(deviceIds)
  }

  private pruneTracksBefore(input: PruneTracksBeforeInput): Promise<TrackCascadeCounts> {
    return this.deps.trackPrune.pruneTracksBefore(input)
  }

  /** Bytes released by the most recent prune — see `TrackPruneRunner`. */
  private get lastPruneBytes(): number {
    return this.deps.trackPrune.lastPruneBytes
  }

  /**
   * The follow-recordings floor per camera, read from the ARCHIVE's hour ledger
   * (`recordingArchive.getStorageUsage`, one call for every camera) — never an
   * availability walk from the epoch, which cost the recorder 2.2 GB and an OOM
   * (D674). LAZY: `ctx` is not assigned when field initialisers run.
   */
  private footageFloorsInstance: ArchiveFootageFloors | null = null

  private get footageFloors(): ArchiveFootageFloors {
    this.footageFloorsInstance ??= new ArchiveFootageFloors({
      api: this.ctx.api,
      logger: this.ctx.logger,
    })
    return this.footageFloorsInstance
  }

  /** The per-device effective cutoffs (mode + footage → numbers). A
   *  follow-recordings camera whose floor could not be read gets NO cutoff this
   *  pass (logged in `ArchiveFootageFloors`), never the custom window. */
  private async deviceRetentionCutoffs(
    deviceId: number,
    nowMs: number,
  ): Promise<DeviceRetentionCutoffs> {
    const raw = await this.readDeviceBlob(deviceId)
    return this.footageFloors.cutoffsFor(deviceId, resolveRetentionSettings(raw), nowMs)
  }

  /** Devices holding event rows, read at most hourly (D871). */
  private readonly eventDeviceIdsMemo = memoEventDeviceIds(async () => [
    ...((await this.eventStore?.countByDevice()) ?? new Map<number, number>()).keys(),
  ])

  /**
   * The devices one retention pass covers — see `retention/retention-scope.ts`
   * for the policy and the measurement.
   *
   * The doc comment here used to say "every camera the hub knows" while the
   * code said `listAll.query({})`: the whole fleet, in the FULL projection. On
   * this hub that is 967 devices to serve ~36 cameras, each one asked ten
   * questions per pass, and the listing itself cost another 967 per-device
   * settings reads inside device-manager. The filter and the projection are
   * both server-side because both halves of that bill are.
   */
  async retentionDeviceIds(): Promise<readonly number[]> {
    return retentionScopeDeviceIds(
      {
        listAll: (input) => this.ctx.api.deviceManager.listAll.query(input),
        listTrackedDeviceIds: async () => (await this.trackStore?.listDeviceIds()) ?? [],
        listEventDeviceIds: this.eventDeviceIdsMemo,
      },
      (half, err) =>
        this.ctx.logger.warn('retention scope half unavailable — sweeping on the other', {
          meta: { half, error: errMsg(err) },
        }),
    )
  }

  /**
   * The retention pass — ONE age-keyed sweep over TRACKS (D61), on ONE window
   * per device (D62).
   *
   * A track is the root of the analytics data model, so deleting one deletes
   * everything it owns: its object events, their child crops, its own media
   * blobs, its unassigned face/plate rows and crops, and its CLIP vector. That
   * cascade is the ONLY way any of those leave.
   *
   * What used to be here was ten independent age sweeps with ten cutoff
   * arithmetics that disagreed with each other. Two of the disagreements were
   * measured: embeddings outliving their events by 14–21 days on one camera,
   * and 5,598 media rows whose track had already been pruned. This method now
   * runs exactly two things, and both take the SAME per-device cutoff:
   *
   *   1. the track sweep, per device, cascading;
   *   2. the TRACKLESS roots — motion, audio and sensor events, which carry no
   *      trackId and are referenced by nothing, so the cascade can never reach
   *      them and a clock is the only thing that can. Motion visit stills leave
   *      with their row inside `evictTracklessBefore`.
   *
   * That clock used to be three more settings (`retentionMotionDays` /
   * `retentionObjectDays` / `retentionAudioDays`). It is now the device's own
   * window, so an operator reads one sentence: *a device has one retention
   * window, and everything scoped to that device is deleted on it.* The only
   * thing outside it is the ops log, which is global and longer than any device
   * window because it records what retention did, including for devices that no
   * longer exist.
   *
   * The old `minObjectCutoffMs` fleet-minimum is gone: every cutoff in here is
   * the device's own. The face/plate buffer caps still run, but as CAPACITY
   * bounds with no clock.
   */
  async sweepRetention(): Promise<void> {
    if (this.shuttingDown || !this.eventStore || !this.mediaStore) return
    const now = Date.now()
    // ONE ops-log row per pass with per-device counts (D871), written in the
    // `finally` so a pass that fails half-way still records what it removed.
    const sweepSummary = new RetentionSweepSummary()
    try {
      const deviceIds = await this.retentionDeviceIds()

      // ── 0. Announce and clear the settings D62 retired ─────────────────
      await this.migrateRetiredRetentionSettings(deviceIds)

      // ── 0b. …and the face suggestion floor D222 retired ────────────────
      await this.purgeStoredSuggestionThreshold(deviceIds)

      // ── 0c. …and the recognizer face-confidence bar D662 retired ───────
      await this.purgeStoredMinFaceConfidence(deviceIds)

      // ── 1. THE age sweep: tracks, per device, cascading ────────────────
      await this.runTrackRetentionSweep(deviceIds, now, sweepSummary)

      // ── 2. The trackless roots, per device, on the SAME window ─────────
      const eventStore = this.eventStore
      const sensorEventStore = this.sensorEventStore
      await sweepTracklessRoots({
        deviceIds,
        nowMs: now,
        resolveCutoffs: (deviceId, nowMs) => this.deviceRetentionCutoffs(deviceId, nowMs),
        evictTracklessEvents: ({ deviceId, cutoffMs }) =>
          eventStore.evictTracklessBefore({ deviceId, cutoffMs }),
        evictSensorEvents: sensorEventStore
          ? (deviceId, cutoffMs) => sensorEventStore.evictBefore(deviceId, cutoffMs)
          : null,
        onEvicted: async (deviceId, evicted, cutoffs) => {
          // Retention activity must be VISIBLE in the audit — as ONE row per
          // pass with the per-device counts (D871), written below.
          sweepSummary.add(deviceId, {
            motion: evicted.motion.length,
            audio: evicted.audio.length,
            sensor: evicted.sensor,
          })
          this.ctx.logger.info('analytics trackless event eviction (age sweep)', {
            tags: { deviceId },
            meta: {
              motion: evicted.motion.length,
              audio: evicted.audio.length,
              sensor: evicted.sensor,
              mode: cutoffs.effectiveMode,
              cutoffMs: cutoffs.cutoffMs,
            },
          })
        },
        onRetentionDisabled: (deviceId) => this.reportRetentionDisabled(deviceId),
        onError: (deviceId, err) => {
          this.ctx.logger.debug('trackless retention sweep (device) failed', {
            tags: { deviceId },
            meta: { error: String(err) },
          })
        },
        shouldStop: () => this.shuttingDown,
      })

      // ── Capacity bounds — NOT age. The unassigned face/plate buffers are
      // ring buffers the recognizer depends on staying small; their rows are
      // track-owned and cascade with their track like everything else.
      await this.holdBufferCaps()
    } catch (err) {
      this.ctx.logger.debug('sweepRetention failed', {
        meta: { error: String(err) },
      })
    } finally {
      const row = sweepSummary.build()
      if (row !== null) await this.eventsOpsLog?.append(row)
    }
  }

  /** Devices already reported as retention-disabled, so the warning is one line
   *  per device per process rather than one every five minutes. */
  private readonly retentionDisabledReported = new Set<number>()

  /**
   * Say out loud that a device ages out NOTHING.
   *
   * `trackRetentionDays: 0` is a legitimate operator choice, and one window
   * means it covers the terminal roots too — so motion and audio events, which
   * a busy camera produces by the thousand per day and which no cascade can
   * ever reach, grow without bound. That is exactly the outcome that must not
   * be inferred from silence: a sweep that deletes nothing and logs nothing
   * reads identically to a sweep that never ran.
   */
  private reportRetentionDisabled(deviceId: number): void {
    if (this.retentionDisabledReported.has(deviceId)) return
    this.retentionDisabledReported.add(deviceId)
    this.ctx.logger.warn('analytics retention is OFF for this device — nothing ages out', {
      tags: { deviceId },
      meta: {
        setting: 'trackRetentionDays = 0',
        affects: 'tracks (and everything they own), motion, audio and sensor events',
      },
    })
  }

  /**
   * Hold the unassigned face + plate buffers to their per-device capacity.
   *
   * There is no cutoff here on purpose. Both buffers used to be swept on
   * `bufferRetentionDays` OR the cap; the age half was a clock over a
   * track-OWNED entity (both rows carry a `trackId`) and it aged crops out from
   * under tracks still well inside their own window. Only the capacity bound
   * remains (D61).
   *
   * The cap is the OPERATOR'S, not the schema default. `bufferMaxPerDevice` is
   * offered on the settings form and this sweep read `FACE_DEFAULTS` instead,
   * so an override was a knob that wrote a store nobody read — the D62 shape.
   * The suggested tier is DERIVED from whatever value is in force
   * (`deriveSuggestedBufferCap`), so the two can never disagree.
   */
  private async holdBufferCaps(): Promise<void> {
    const mediaStore = this.mediaStore
    if (!mediaStore) return
    const bufferMaxPerDevice = await this.resolveBufferCap()
    const maxSuggestedPerDevice = deriveSuggestedBufferCap(bufferMaxPerDevice)
    if (this.faceStore) {
      try {
        const deletedFaceIds = await this.faceStore.pruneCapOverflow({
          maxPerDevice: bufferMaxPerDevice,
          maxSuggestedPerDevice,
        })
        if (deletedFaceIds.length > 0) {
          await mediaStore.deleteForOwner('face', deletedFaceIds)
          this.ctx.logger.info('face buffer capacity prune', {
            meta: {
              deleted: deletedFaceIds.length,
              cap: bufferMaxPerDevice,
              suggestedCap: maxSuggestedPerDevice,
            },
          })
        }
      } catch (err) {
        this.ctx.logger.debug('face buffer cap prune failed', {
          meta: { error: String(err) },
        })
      }
    }
    if (this.plateStore) {
      try {
        const deletedPlateIds = await this.plateStore.pruneCapOverflow({
          maxPerDevice: bufferMaxPerDevice,
        })
        if (deletedPlateIds.length > 0) {
          await mediaStore.deleteForOwner('plate', deletedPlateIds)
          this.ctx.logger.info('plate buffer capacity prune', {
            meta: {
              deleted: deletedPlateIds.length,
              cap: bufferMaxPerDevice,
            },
          })
        }
      } catch (err) {
        this.ctx.logger.debug('plate buffer cap prune failed', {
          meta: { error: String(err) },
        })
      }
    }
  }

  /**
   * The buffer capacity actually in force: the GLOBAL setting, falling back to
   * the schema default when the store cannot be read.
   *
   * Global-only on purpose. The sweep is one pass over the whole collection and
   * a per-device cascade would mean one settings read per camera on every tick,
   * for a knob whose whole job is bounding a table. A per-camera capacity is a
   * decision nobody has asked for; the fallback here is the same number the
   * sweep used unconditionally before, so a settings outage cannot make the
   * bound stricter than it has ever been.
   */
  async resolveBufferCap(): Promise<number> {
    try {
      return resolveFaceSettings(await this.resolveGlobalStore()).bufferMaxPerDevice
    } catch (err) {
      this.ctx.logger.debug('face buffer cap: global settings unreadable, using the default', {
        meta: { error: String(err), cap: FACE_DEFAULTS.bufferMaxPerDevice },
      })
      return FACE_DEFAULTS.bufferMaxPerDevice
    }
  }

  /**
   * THE age sweep (D61). For every device, prune the tracks older than that
   * device's own window — `trackRetentionDays` (default 7; 0 = keep forever →
   * skipped) or the follow-recordings footage horizon — through the cascade, so
   * every entity the track owns goes with it.
   *
   * **One sweep does not mean one cutoff.** Retention is per device and that is
   * deliberate: measured 1 day on 104 against 7 on 101/102. What is singular is
   * the SELECTION — one entity kind, one clock, one cascade — not the number.
   *
   * `deviceIds` is passed in so the whole pass shares one device set and one
   * `now`, rather than each sweep resolving its own and drifting.
   */
  private async runTrackRetentionSweep(
    deviceIds: readonly number[],
    nowMs: number,
    sweepSummary: RetentionSweepSummary,
  ): Promise<void> {
    if (this.shuttingDown || !this.trackStore) return
    try {
      const total = await sweepTrackRetention({
        listDeviceIds: async () => deviceIds,
        resolveCutoffMs: async (deviceId) =>
          (await this.deviceRetentionCutoffs(deviceId, nowMs)).cutoffMs,
        pruneTracksBefore: async (deviceId, cutoffMs) => {
          const counts = await this.pruneTracksBefore({ deviceId, cutoffMs })
          // What the sweep did NOT delete, and why. A staging track is work
          // deliberately skipped, and skipped work that leaves no line reads as
          // "retention did nothing" — staging is the one retention outcome an
          // operator can cause by hand and then not remember causing (D81).
          // `trained` tracks are NOT counted here: they were swept like any
          // other row, so reporting them as held would be a lie.
          const staging = await this.trackStore?.countStaging({
            deviceId,
            olderThanMs: cutoffMs,
          })
          if (staging !== undefined && staging > 0) {
            this.ctx.logger.info('track retention held staging tracks (retrainStatus)', {
              tags: { deviceId },
              meta: { deviceId, staging, cutoffMs, deleted: counts.tracks },
            })
          }
          // Same sentence as staging: a favourited pin that leaves no line
          // reads as "retention did nothing". The skip already lives in
          // `listIdsBefore` (`whereNot: { favourited: true }`); this is the
          // operator-visible half.
          const favourited = await this.trackStore?.countFavourited({
            deviceId,
            olderThanMs: cutoffMs,
          })
          if (favourited !== undefined && favourited > 0) {
            this.ctx.logger.info('track retention held favourited tracks', {
              tags: { deviceId },
              meta: { deviceId, favourited, cutoffMs, deleted: counts.tracks },
            })
          }
          // Same sentence again: a camera whose only held tracks are bench-pinned
          // (a promoted tracking-tape window, D681) must not read as "retention
          // did nothing".
          const benchPinned = await this.trackStore?.countBenchPinned({
            deviceId,
            olderThanMs: cutoffMs,
          })
          if (benchPinned !== undefined && benchPinned > 0) {
            this.ctx.logger.info('track retention held bench-pinned tracks', {
              tags: { deviceId },
              meta: { deviceId, benchPinned, cutoffMs, deleted: counts.tracks },
            })
          }
          if (counts.tracks > 0) {
            sweepSummary.add(deviceId, {
              tracks: counts.tracks,
              trackEvents: counts.events,
              media: counts.media,
              faces: counts.faces,
              plates: counts.plates,
              embeddings: counts.embeddings,
            })
            // Real bytes. This was a literal 0 on every row the addon ever
            // wrote — "a counter that can only ever be 0 reads as nothing to
            // reclaim", and that is how the leak stayed invisible (D161).
            sweepSummary.addBytes(this.lastPruneBytes)
          }
          return counts
        },
        now: () => nowMs,
        onError: (deviceId, err) => {
          this.ctx.logger.debug('track retention sweep (device) failed', {
            tags: { deviceId },
            meta: { deviceId, error: String(err) },
          })
        },
      })
      if (total > 0) {
        this.ctx.logger.info('analytics track retention sweep', {
          meta: { tracks: total },
        })
      }
    } catch (err) {
      if (this.shuttingDown) return
      this.ctx.logger.debug('runTrackRetentionSweep failed', {
        meta: { error: String(err) },
      })
    }
  }
}
