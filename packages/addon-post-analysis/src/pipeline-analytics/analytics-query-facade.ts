/**
 * `AnalyticsQueryFacade` — the thin read/prune/footprint/ops-log cap-method
 * bodies (refactor S8, spec `2026-07-22-post-analysis-maintainability-refactor-design.md`).
 *
 * Every method here is a store delegate moved VERBATIM out of the addon god
 * class (spec A2 — no behavior change): track reads, event reads (+ the
 * `mediaUrl` stamping for slim projections), media listings, the events-
 * management footprint/prune/ops-log suite. The addon class keeps one-line
 * delegating members because the pipeline-analytics cap registers the addon
 * instance itself as provider (`provider: this`, `implements
 * IPipelineAnalyticsProvider`) and the existing specs drive these methods
 * through the addon instance directly.
 *
 * Deps are LAZY getters: the stores are late-bound (built in `onInitialize`),
 * so the facade is constructed at field-init time and resolves each store at
 * call time — exactly the nullable-field reads the inline bodies performed.
 *
 * NOT here (real logic stays on the addon class): `listEventKinds`,
 * `getKeyEvents`, `searchObjectEvents`, `clearTracks`, `deleteTracks`,
 * `pruneTracksBefore`, `wipeAllAnalytics`, the settings-contribution trio and
 * the data-plane thumbnail resolvers (display-fallback logic).
 */

import type {
  AudioEvent,
  EventDensityForDevice,
  EventMediaKindBreakdown,
  EventOwnerType,
  EventPruneCounts,
  EventStoreDeviceFootprint,
  EventStoreFootprint,
  IScopedLogger,
  MediaFile,
  MediaFileInfo,
  MediaFileKind,
  MediaFileRef,
  MotionEvent,
  ObjectEvent,
  OpsLogEntry,
  OpsLogReason,
  RecentTracksPage,
  SensorEvent,
  Track,
  TrackProjection,
  TrackSource,
  TrackZoneFilter,
} from '@camstack/types'
import { EVENT_DENSITY_BATCH_MAX } from '@camstack/types'
import { mediaOwnerUrl, toWireMediaFile, toWireMediaFileInfo } from './media-file-url.js'

import type { EventDensityBucket, EventStore } from './store/event-store.js'
import type { MediaStore, StoredMediaFile } from './store/media-store.js'
import type { OpsLogStore } from './store/ops-log-store.js'
import type { SensorEventStore } from './store/sensor-event-store.js'
import type { TrackStore } from './store/track-store.js'
import type { ScopedMediaRows } from './track-media-scope.js'
import {
  collectTrackMedia,
  storedKindsForScope,
  trackMediaOwnerScopes,
  trackMediaScopesForKinds,
} from './track-media-scope.js'
import type { ZoneCatalogueCache } from './zone-catalogue-cache.js'
import { stampZoneNames } from './zone-name-stamp.js'

/**
 * What `getEventMedia` / `listEventMedia` are asked. Named types, and the
 * owner TYPE is part of the question (D482): an event is a row in one of three
 * tables that each number from 1 since D474, so a bare id names up to three
 * rows and the provider used to pick the first it found.
 */
export interface ListEventMediaInput {
  readonly ownerType: EventOwnerType
  readonly eventId: number
  readonly deviceId: number
}

export interface GetEventMediaInput extends ListEventMediaInput {
  readonly kind?: MediaFileKind
}

/** Lazy accessors into the addon's late-bound store fields + logger/base-url. */
export interface AnalyticsQueryFacadeDeps {
  readonly trackStore: () => TrackStore | null
  readonly eventStore: () => EventStore | null
  readonly mediaStore: () => MediaStore | null
  readonly sensorEventStore: () => SensorEventStore | null
  readonly opsLog: () => OpsLogStore | null
  /** Non-null once the event-media data-plane is served (mediaUrl stamping). */
  readonly eventMediaBaseUrl: () => string | null
  /**
   * `/addon/<addonId>/event-media` — the path every media row is addressed
   * under.
   *
   * Deliberately NOT `eventMediaBaseUrl`, and deliberately not nullable. That
   * one is null until `dataPlane.serve` succeeds, and a media row whose `url`
   * depended on a boot race would be absent exactly when an operator is
   * looking at a broken tile. This prefix is a pure function of the addon id,
   * so a row always names where its bytes are; whether the plane is up is the
   * plane's own (already logged) problem, not a hole in the contract.
   */
  readonly eventMediaPathPrefix: () => string
  readonly logger: () => IScopedLogger
  /**
   * Zone id→name dictionary. Optional so the existing specs, which drive these
   * methods through the addon instance, keep constructing the facade unchanged
   * — omitted means the ids are returned without names, never a wrong name.
   */
  readonly zoneCatalogue?: () => ZoneCatalogueCache | null
}

export class AnalyticsQueryFacade {
  private readonly deps: AnalyticsQueryFacadeDeps

  constructor(deps: AnalyticsQueryFacadeDeps) {
    this.deps = deps
  }

  // ── Track reads ───────────────────────────────────────────────────────

  /**
   * Stamp the human `zoneNames` onto a batch of tracks.
   *
   * ONE place, on the read path, for every track surface — `zonesVisited` is
   * ids and a client cannot resolve them without a per-camera fan-out. A hub
   * with no catalogue reader configured returns the tracks untouched.
   */
  private async withZoneNames(tracks: readonly Track[]): Promise<readonly Track[]> {
    const cache = this.deps.zoneCatalogue?.() ?? null
    if (cache === null || tracks.length === 0) return tracks
    const zoned = tracks.filter((t) => t.zonesVisited.length > 0)
    if (zoned.length === 0) return tracks
    await cache.ensure(zoned.map((t) => t.deviceId))
    return stampZoneNames(tracks, (deviceId) => cache.lookup(deviceId))
  }

  async getActiveTracks(input: { deviceId: number }): Promise<readonly Track[]> {
    return this.withZoneNames(this.deps.trackStore()?.getActive(input.deviceId) ?? [])
  }

  async getTrack(input: { deviceId: number; trackId: string }): Promise<Track | null> {
    const store = this.deps.trackStore()
    const active = store?.getActiveByTrack(input.trackId)
    const track = active ?? (await store?.getPersistedByTrackId(input.trackId)) ?? null
    if (track === null) return null
    // The lookup is by trackId alone; the device the caller NAMED is what the
    // share-view gate authorised. A track of another device answers as absent,
    // never as itself — otherwise a link scoped to camera A reads camera B.
    if (track.deviceId !== input.deviceId) return null
    const [named] = await this.withZoneNames([track])
    return named ?? track
  }

  async listTracks(input: {
    deviceId: number
    since?: number
    until?: number
    limit?: number
    zone?: TrackZoneFilter
    projection?: TrackProjection
    /** Opt back INTO stationary-promoted rows. Default hides them: a parked
     *  object lives on the stationary registry, not in the passage feed
     *  (operator decision, 2026-08-15). */
    includeStationary?: boolean
    /** Track classes to keep. Absent or empty ⟺ no filter — see the cap. */
    classes?: readonly string[]
    /** Track SOURCES to leave out. Absent or empty ⟺ no filter — see
     *  `ExcludeSourcesDoc` in the cap. */
    excludeSources?: readonly TrackSource[]
  }): Promise<readonly Track[]> {
    const store = this.deps.trackStore()
    if (!store) return []
    return this.withZoneNames(
      await store.queryHistorical({
        ...input,
        excludeStationaryPromotions: input.includeStationary !== true,
      }),
    )
  }

  /**
   * Batched cluster-wide track listing — one merged (`lastSeen` DESC,
   * `trackId` DESC) page across the requested devices with a stable opaque
   * cursor. Replaces the per-camera `listTracks` fan-out for the events page
   * first paint + the reel. See `TrackStore.queryRecent` for the per-device
   * indexed page + k-way merge and the cursor encoding.
   */
  async listRecentTracks(input: {
    deviceIds: number[]
    since?: number
    until?: number
    limit?: number
    cursor?: string
    projection?: TrackProjection
    /** Opt back INTO stationary-promoted rows — hidden by default (the feed
     *  is passages; parked objects live on the stationary registry). */
    includeStationary?: boolean
    /** Track classes to keep. Absent or empty ⟺ no filter — see the cap. */
    classes?: readonly string[]
    /** Track SOURCES to leave out. Absent or empty ⟺ no filter — see
     *  `ExcludeSourcesDoc` in the cap. */
    excludeSources?: readonly TrackSource[]
  }): Promise<RecentTracksPage> {
    const page = (await this.deps.trackStore()?.queryRecent({
      ...input,
      excludeStationaryPromotions: input.includeStationary !== true,
    })) ?? {
      tracks: [],
      nextCursor: null,
    }
    return { ...page, tracks: await this.withZoneNames(page.tracks) }
  }

  // ── Event reads ───────────────────────────────────────────────────────

  /** Per-camera sensor-event history (state changes of linked devices). */
  async getSensorEvents(input: {
    deviceId: number
    since?: number
    until?: number
    kinds?: string[]
    limit?: number
  }): Promise<readonly SensorEvent[]> {
    return this.deps.sensorEventStore()?.query(input) ?? []
  }

  async getMotionEvents(input: {
    deviceId: number
    since?: number
    until?: number
    limit?: number
    projection?: 'full' | 'slim'
  }): Promise<readonly MotionEvent[]> {
    const events = await (this.deps.eventStore()?.queryMotion(input) ??
      Promise.resolve<readonly MotionEvent[]>([]))
    if (input.projection !== 'slim' || this.deps.eventMediaBaseUrl() === null) return events
    return this.withMediaUrl(events, 'motion')
  }

  async getEventDensity(input: {
    deviceId: number
    since: number
    until: number
    bucketMs: number
  }): Promise<readonly EventDensityBucket[]> {
    return this.deps.eventStore()?.densityByKind(input) ?? []
  }

  /**
   * `getEventDensity` for a SET of cameras, in one round trip.
   *
   * A multi-camera timeline re-asks the heatmap of every camera in the grid on
   * every day change — N browser → hub → post-analysis round trips for N
   * independent, already-indexed histogram queries. The per-camera query is
   * UNCHANGED (the same `densityByKind`, one per deviceId, run concurrently in
   * this process); only the transport collapses.
   *
   * Every requested id gets a row. A camera whose store read rejects is marked
   * `'unreadable'` and SAID SO, per camera: `buckets: []` on a `'read'` row is
   * the claim "nothing happened in this window", and a dropped read that
   * borrowed that spelling would tell an operator a camera was quiet when the
   * truth is that nobody looked.
   *
   * An over-cap ask is REFUSED, never truncated — a short answer is
   * indistinguishable from a complete one.
   */
  async getEventDensityBatch(input: {
    deviceIds: readonly number[]
    since: number
    until: number
    bucketMs: number
  }): Promise<readonly EventDensityForDevice[]> {
    if (input.deviceIds.length > EVENT_DENSITY_BATCH_MAX) {
      throw new Error(
        `getEventDensityBatch: ${input.deviceIds.length} deviceIds exceeds the ${EVENT_DENSITY_BATCH_MAX} cap — split the ask into ${Math.ceil(input.deviceIds.length / EVENT_DENSITY_BATCH_MAX)} calls`,
      )
    }
    return Promise.all(
      input.deviceIds.map(async (deviceId): Promise<EventDensityForDevice> => {
        try {
          const buckets = await this.getEventDensity({
            deviceId,
            since: input.since,
            until: input.until,
            bucketMs: input.bucketMs,
          })
          return { deviceId, read: 'read', buckets }
        } catch (err: unknown) {
          // A branch that drops work silently reads as "it never happened", and
          // every question asked of a heatmap is per-camera.
          this.deps.logger().warn('event density could not be read', {
            tags: { deviceId },
            meta: { error: String(err), since: input.since, until: input.until },
          })
          return { deviceId, read: 'unreadable', buckets: [] }
        }
      }),
    )
  }

  async getObjectEvents(input: {
    deviceId: number
    since?: number
    until?: number
    classFilter?: string
    limit?: number
    projection?: 'full' | 'slim'
  }): Promise<readonly ObjectEvent[]> {
    const events = await (this.deps.eventStore()?.queryObject(input) ??
      Promise.resolve<readonly ObjectEvent[]>([]))
    if (input.projection !== 'slim' || this.deps.eventMediaBaseUrl() === null) return events
    return this.withMediaUrl(events, 'object')
  }

  async getAudioEvents(input: {
    deviceId: number
    since?: number
    until?: number
    limit?: number
    projection?: 'full' | 'slim'
  }): Promise<readonly AudioEvent[]> {
    const events = await (this.deps.eventStore()?.queryAudio(input) ??
      Promise.resolve<readonly AudioEvent[]>([]))
    if (input.projection !== 'slim' || this.deps.eventMediaBaseUrl() === null) return events
    return this.withMediaUrl(events, 'audio')
  }

  // ── Media listings ────────────────────────────────────────────────────

  async getEventMedia(input: GetEventMediaInput): Promise<readonly MediaFile[]> {
    // `deviceId` is the authorization subject (the scope matcher gates on
    // it); the store scopes the query by it, so a media row only ever
    // answers to the device it was written for.
    //
    // `kind` goes INTO the query, not onto the answer: filtering afterwards
    // still opened and base64-encoded every kind the event owns before
    // discarding all but one.
    const store = this.deps.mediaStore()
    if (store === null) return []
    const prefix = this.deps.eventMediaPathPrefix()
    // ONE list, of the table the caller NAMED (D482). This used to probe
    // `EVENT_OWNER_TYPES` in order and stop at the first table that owned
    // anything, because the input was a bare id — and on the live hub that
    // probe had a known answer: 299 883 of 300 559 event-owned media rows are
    // `motion`, so every object event was answered with its motion namesake's
    // media. An event is a row in ONE table and the caller knows which.
    const kinds = input.kind === undefined ? undefined : [input.kind]
    const rows = await store.listByOwner(
      input.ownerType,
      String(input.eventId),
      input.deviceId,
      kinds,
    )
    return rows.map((row) => toWireMediaFile(row, prefix))
  }

  /**
   * A track's media WITH the bytes, restricted to `kinds` when given.
   *
   * Reads every owner a track's media lives under — its own rows plus the face
   * and plate detail crops, whose stored `kind: 'crop'` is published as
   * `faceCrop` / `plateCrop`. See `track-media-scope.ts` for why the rename
   * happens on the way out and not in the caller's question.
   */
  async getTrackMedia(input: {
    trackId: string
    kinds?: readonly MediaFileKind[]
    deviceId: number
  }): Promise<readonly MediaFile[]> {
    const store = this.deps.mediaStore()
    if (store === null) return []
    const prefix = this.deps.eventMediaPathPrefix()
    const scopes = trackMediaScopesForKinds(input.trackId, input.kinds)
    const scoped = await Promise.all(
      scopes.map(async (scope): Promise<ScopedMediaRows<StoredMediaFile>> => {
        // The kinds go into the QUERY: every row that comes back has already
        // had its blob read and base64-encoded, so a kind filtered off the
        // answer has been paid for in full.
        const stored = storedKindsForScope(scope, input.kinds)
        if (stored === null) return { scope, rows: [] }
        return {
          scope,
          rows: await store.listByOwner(scope.ownerKind, scope.ownerId, input.deviceId, stored),
        }
      }),
    )
    // The relabel happens on the STORED row, and the wire row's `url` is built
    // from the row's own id — so a `plateCrop` is served from the same address
    // whatever it is published as. Under the composite key this was a real
    // hazard: the url had to come from `row.key` verbatim or it 404'd exactly
    // the face/plate rows whose stored kind is `crop` (D482).
    const collected = collectTrackMedia(scoped, (row, kind) => ({ ...row, kind }), input.kinds)
    return collected.map((row) => toWireMediaFile(row, prefix))
  }

  /**
   * An event's media WITHOUT the bytes.
   *
   * Index rows only — it never opens a blob. The track detail modal unions
   * this with {@link listTrackMedia} to build its filmstrip and then fetches
   * each tile from the `event-media` plane by media id, so the bytes this used
   * to carry were read, base64'd, shipped and discarded.
   */
  async listEventMedia(input: ListEventMediaInput): Promise<readonly MediaFileInfo[]> {
    const store = this.deps.mediaStore()
    if (store === null) return []
    const prefix = this.deps.eventMediaPathPrefix()
    // ONE list, of the table the caller NAMED — see {@link getEventMedia} for
    // the probe this replaced and what it cost (D482).
    const rows = await store.listInfoByOwner(input.ownerType, String(input.eventId), input.deviceId)
    return rows.map((row) => toWireMediaFileInfo(row, prefix))
  }

  /**
   * A track's media WITHOUT the bytes.
   *
   * Reads the INDEX ROWS only — it never touches a blob. Stripping `base64`
   * off `getTrackMedia` would have been the obvious shape and the wrong one:
   * that path reads every blob off disk and base64-encodes it first, so the
   * response would shrink while the work did not. Measured: 7.67 MB read and
   * ~10 MB of string allocated, to answer a question the index already holds.
   *
   * Covers the same owners as {@link getTrackMedia} — a manifest that listed
   * fewer keys than the byte read can serve (or more) is the disagreement the
   * viewer's per-entry loader turns into a red triangle.
   */
  async listTrackMedia(input: {
    trackId: string
    deviceId: number
  }): Promise<readonly MediaFileInfo[]> {
    const store = this.deps.mediaStore()
    if (store === null) return []
    const prefix = this.deps.eventMediaPathPrefix()
    const scoped = await Promise.all(
      trackMediaOwnerScopes(input.trackId).map(
        async (scope): Promise<ScopedMediaRows<MediaFileRef>> => ({
          scope,
          rows: await store.listInfoByOwner(scope.ownerKind, scope.ownerId, input.deviceId),
        }),
      ),
    )
    const collected = collectTrackMedia(scoped, (row, kind) => ({ ...row, kind }), undefined)
    return collected.map((row) => toWireMediaFileInfo(row, prefix))
  }

  // ── Events management (footprint + prune + ops-log) ───────────────────

  async pruneEventsBefore(input: {
    deviceId: number
    cutoffMs: number
  }): Promise<{ motion: number; object: number; audio: number }> {
    const eventStore = this.deps.eventStore()
    if (!eventStore) return { motion: 0, object: 0, audio: 0 }
    const { counts, ids, byKind } = await eventStore.pruneBefore(input)
    const mediaStore = this.deps.mediaStore()
    if (ids.length > 0 && mediaStore) {
      await mediaStore.deleteForEvents(byKind)
    }
    const { motion, object, audio } = counts
    if (motion + object + audio > 0) {
      this.deps.logger().info('analytics event eviction (floor)', {
        tags: { deviceId: input.deviceId },
        meta: { deviceId: input.deviceId, cutoffMs: input.cutoffMs, motion, object, audio },
      })
    }
    return counts
  }

  /**
   * Durable event-store footprint for the events-management UI: event ROWS
   * (motion + object + audio) per camera + total, and event-owned media BYTES
   * on disk per camera + total. Cameras with neither rows nor bytes are
   * omitted; the rest come back ordered by bytes, descending, which is the
   * order the operator's table renders.
   *
   * ## The device set is a union of THREE sources
   *
   * It used to be `media ∪ tracks`, and a camera holding events but no media
   * row and no persisted track was therefore invisible — not listed, and its
   * events missing from `totalRows`. That combination is not exotic: media
   * retention, a media deletion and `pruneTracksBefore` all run on clocks of
   * their own, and every one of them can outlive the event rows. The number
   * this method exists to produce is the denominator for a deletion, so an
   * undercount is the one failure mode that matters, and it was silent.
   *
   * Events now contribute their own device set, so a camera is present if ANY
   * of the three sources has ever heard of it.
   *
   * ## The cost is the answer, not the table
   *
   * Three grouped reads for the event rows (one per event collection, never
   * three per camera), one grouped read plus one aggregate per camera for the
   * media bytes, one for the track device set. The retired shape paid ~1 250
   * round trips for the media half alone and timed out at 60 s on every call.
   * See {@link MediaStore.footprintByDevice} and {@link EventStore.countByDevice}.
   *
   * A store that cannot answer THROWS rather than returning zeroes — see the
   * same note on both.
   */
  async getEventStoreFootprint(): Promise<EventStoreFootprint> {
    const eventStore = this.deps.eventStore()
    const mediaStore = this.deps.mediaStore()
    if (!eventStore || !mediaStore) return { totalRows: 0, totalBytes: 0, devices: [] }
    const [mediaByDevice, eventRowsByDevice] = await Promise.all([
      mediaStore.footprintByDevice(),
      eventStore.countByDevice(),
    ])
    const deviceIds = new Set<number>(mediaByDevice.keys())
    for (const id of eventRowsByDevice.keys()) deviceIds.add(id)
    const trackStore = this.deps.trackStore()
    if (trackStore) {
      for (const id of await trackStore.listDeviceIds()) deviceIds.add(id)
    }
    const devices: EventStoreDeviceFootprint[] = []
    let totalRows = 0
    let totalBytes = 0
    for (const deviceId of deviceIds) {
      const rows = eventRowsByDevice.get(deviceId) ?? 0
      const bytes = mediaByDevice.get(deviceId)?.bytes ?? 0
      if (rows === 0 && bytes === 0) continue
      totalRows += rows
      totalBytes += bytes
      devices.push({ deviceId, rows, bytes })
    }
    devices.sort((a, b) => b.bytes - a.bytes)
    return { totalRows, totalBytes, devices }
  }

  /**
   * The media footprint by KIND — the axis that says what is safe to delete.
   * See {@link MediaStore.footprintByKind}.
   *
   * An absent media store is an empty breakdown, not a refusal: it is the same
   * "the addon has not finished booting" branch every other method here takes,
   * and the zeroes are accompanied by an empty `kinds` list, which no reader
   * can mistake for a measured "there is nothing".
   */
  async getEventMediaFootprintByKind(input: {
    deviceId?: number
  }): Promise<EventMediaKindBreakdown> {
    const mediaStore = this.deps.mediaStore()
    if (!mediaStore) {
      return { totalRows: 0, totalBytes: 0, kinds: [], unaccountedRows: 0, unaccountedBytes: 0 }
    }
    return mediaStore.footprintByKind(input.deviceId)
  }

  /**
   * Cluster-wide prune of events with `timestamp < olderThanMs` across every
   * camera (via the device-agnostic `evictBefore`), deleting each pruned event's
   * media in lockstep. Logs one global (`deviceId:null`) events ops-log row.
   * `bytesReclaimed` is 0 (media deletion does not surface freed bytes).
   */
  async pruneEvents(input: {
    olderThanMs: number
    reason?: OpsLogReason
  }): Promise<EventPruneCounts> {
    const eventStore = this.deps.eventStore()
    if (!eventStore) return { motion: 0, object: 0, audio: 0 }
    const cutoff = input.olderThanMs
    const evicted = await eventStore.evictTracklessBefore({ cutoffMs: cutoff })
    // Object events are TRACK-OWNED and have no retention clock of their own
    // (D61). This is the operator's explicit cutoff, so it goes through the
    // operator-only path, which says so in its own name.
    const objectIds = await eventStore.pruneObjectEventsBefore(cutoff)
    const ids = [...evicted.motion, ...objectIds, ...evicted.audio]
    const mediaStore = this.deps.mediaStore()
    if (ids.length > 0 && mediaStore) {
      await mediaStore.deleteForEvents({
        motion: evicted.motion,
        object: objectIds,
        audio: evicted.audio,
      })
    }
    const counts: EventPruneCounts = {
      motion: evicted.motion.length,
      object: objectIds.length,
      audio: evicted.audio.length,
    }
    const total = counts.motion + counts.object + counts.audio
    await this.deps.opsLog()?.append({
      op: 'prune',
      reason: input.reason ?? 'retention',
      deviceId: null,
      itemsAffected: total,
      bytesReclaimed: 0,
      detail: `pruned events older than ${cutoff}`,
    })
    if (total > 0) {
      this.deps.logger().info('analytics events pruned (cluster)', {
        meta: { cutoffMs: cutoff, ...counts },
      })
    }
    return counts
  }

  /**
   * Manually delete EVERY event (motion + object + audio) for one camera and its
   * event-owned media in lockstep. Logs a manual events ops-log row.
   */
  async deleteDeviceEvents(input: {
    deviceId: number
    /** Set by the device-removal hook (D865): the audit row then reads as a
     *  prune with that reason instead of an operator's manual delete. */
    reason?: OpsLogReason
  }): Promise<EventPruneCounts> {
    if (!this.deps.eventStore()) return { motion: 0, object: 0, audio: 0 }
    // cutoff = MAX so `timestamp < cutoff` matches every row for the device.
    const counts = await this.pruneEventsBefore({
      deviceId: input.deviceId,
      cutoffMs: Number.MAX_SAFE_INTEGER,
    })
    const total = counts.motion + counts.object + counts.audio
    const byRemoval = input.reason !== undefined
    await this.deps.opsLog()?.append({
      op: byRemoval ? 'prune' : 'manual-delete',
      reason: input.reason ?? 'manual',
      deviceId: input.deviceId,
      itemsAffected: total,
      bytesReclaimed: 0,
      detail: byRemoval
        ? 'the device was deleted — its events were removed with it'
        : 'deleted all events for device',
    })
    return counts
  }

  /** The events ops-log rows (newest-first), optionally scoped to one camera. */
  async listOpsLog(input: { deviceId?: number; limit?: number }): Promise<readonly OpsLogEntry[]> {
    return (await this.deps.opsLog()?.list(input)) ?? []
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Return a new array where each event gets a `mediaUrl` stamp pointing
   * to its thumbnail on the event-media data-plane.
   *
   * Only called when `eventMediaBaseUrl()` is non-null (guard sits in
   * the callers), so the template literal is safe.
   *
   * The URL names the owner TABLE and the event's GENERATION (D482 + D694):
   * a bare `${base}/${id}` was both ambiguous across tables and unable to
   * survive a reused rowid. New stamps always carry `/o/<type>/<id>/g/…`.
   */
  // `string | number`: event ids are rowids since D474, track ids are still
  // uuids, and this helper serves both — but slim event projections always
  // have numeric ids plus deviceId/timestamp.
  private withMediaUrl<
    T extends {
      readonly id: string | number
      readonly deviceId: number
      readonly timestamp: number
    },
  >(events: readonly T[], ownerType: EventOwnerType): readonly T[] {
    const base = this.deps.eventMediaBaseUrl()
    if (base === null) return events
    return events.map((e) => ({
      ...e,
      mediaUrl: mediaOwnerUrl(base, ownerType, String(e.id), {
        deviceId: e.deviceId,
        recordAt: e.timestamp,
      }),
    }))
  }
}
